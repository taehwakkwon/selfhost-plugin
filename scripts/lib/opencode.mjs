import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { createOpencodeClient } from "@opencode-ai/sdk";

import { createTempDir, readJsonFile, writeJsonFile } from "./fs.mjs";
import { binaryAvailable, terminateProcessTree } from "./process.mjs";
import { buildOpencodeConfig, PROVIDER_ID } from "./opencode-provider-config.mjs";

const READY_TIMEOUT_MS = 15000;
const READY_POLL_INTERVAL_MS = 200;
const READY_ATTEMPT_TIMEOUT_MS = 5000;

export function getOpencodeAvailability(cwd) {
  return binaryAvailable("opencode", ["--version"], { cwd });
}

export function getSessionRuntimeStatus() {
  return {
    mode: "per-job",
    label: "per-job runtime",
    detail: "Each selfhost job starts its own opencode server on an ephemeral port and tears it down when the job finishes.",
    endpoint: null
  };
}

export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(port, deadline) {
  while (Date.now() < deadline) {
    try {
      // Without its own timeout, a single slow/stuck attempt can block past
      // the overall deadline for minutes (observed under load) before the
      // while-condition ever gets re-checked, turning a 15s budget into an
      // effectively unbounded hang.
      const response = await fetch(`http://127.0.0.1:${port}/doc`, {
        signal: AbortSignal.timeout(READY_ATTEMPT_TIMEOUT_MS)
      });
      // An unconsumed body leaves the keep-alive socket marked busy in
      // undici's connection pool, which then stalls every later request to
      // this same origin (session.create(), the SSE subscribe, ...)
      // indefinitely. Always drain it before deciding whether to return.
      await response.body?.cancel();
      if (response.ok) {
        return;
      }
    } catch {
      // Server not accepting connections yet, or this attempt timed out;
      // keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`opencode serve did not become ready on port ${port} within ${READY_TIMEOUT_MS}ms.`);
}

export async function startOpencodeServer(selfhostConfig, permissionProfile) {
  const configDir = createTempDir("selfhost-opencode-config-");
  const configFile = path.join(configDir, "opencode.json");
  writeJsonFile(configFile, buildOpencodeConfig(selfhostConfig, permissionProfile));

  const port = await findFreePort();
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_CONFIG: configFile },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  // spawn() emits 'error' instead of 'exit' when the binary itself can't be
  // launched (e.g. ENOENT). Without a listener, that 'error' event is
  // unhandled and crashes the whole Node process instead of failing this
  // one job — so it must feed the same race as exitPromise, not be ignored.
  const spawnErrorPromise = new Promise((_resolve, reject) => {
    child.once("error", (error) => reject(error));
  });

  try {
    await Promise.race([
      waitForReady(port, Date.now() + READY_TIMEOUT_MS),
      exitPromise.then((exit) => {
        throw new Error(
          `opencode serve exited before becoming ready (code=${exit.code}, signal=${exit.signal}): ${stderr.trim()}`
        );
      }),
      spawnErrorPromise
    ]);
  } catch (error) {
    terminateProcessTree(child.pid ?? Number.NaN);
    fs.rmSync(configDir, { recursive: true, force: true });
    throw error;
  }

  return {
    port,
    pid: child.pid,
    configDir,
    baseUrl: `http://127.0.0.1:${port}`,
    getStderr: () => stderr,
    async stop() {
      terminateProcessTree(child.pid ?? Number.NaN);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  };
}

export function buildSessionTitle(prompt) {
  const trimmed = String(prompt ?? "").trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed || "selfhost session";
}

export function extractFinalText(promptResult) {
  const parts = Array.isArray(promptResult?.parts) ? promptResult.parts : [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function summarizeEventProperties(properties) {
  try {
    return JSON.stringify(properties ?? {}).slice(0, 200);
  } catch {
    return "";
  }
}

function emitProgress(onProgress, message, phase, extra = {}) {
  onProgress?.({ message, phase, ...extra });
}

function streamProgress(client, onProgress) {
  let stopped = false;
  // The SSE helper auto-reconnects on a dropped connection and only checks
  // this signal between attempts. Without it, killing the opencode server
  // just makes every reconnect attempt fail, and it retries forever with
  // growing backoff instead of ever giving up.
  const abortController = new AbortController();
  const done = (async () => {
    try {
      const events = await client.event.subscribe({ signal: abortController.signal });
      for await (const event of events.stream) {
        if (stopped) {
          break;
        }
        emitProgress(onProgress, `${event.type}: ${summarizeEventProperties(event.properties)}`, null);
      }
    } catch {
      // Progress streaming is best-effort; the awaited session.prompt() result is authoritative.
    }
  })();

  return {
    stop() {
      stopped = true;
      abortController.abort();
    },
    done
  };
}

export async function runOpencodeTurn(cwd, options) {
  const { selfhostConfig, permissionProfile, modelId, prompt, sessionId, onProgress } = options;

  if (!prompt || !prompt.trim()) {
    throw new Error("A prompt is required for this selfhost run.");
  }

  emitProgress(onProgress, "Starting opencode server.", "starting");
  const server = await startOpencodeServer(selfhostConfig, permissionProfile);
  emitProgress(onProgress, `opencode server ready on port ${server.port}.`, "starting", {
    serverBaseUrl: server.baseUrl
  });

  // The SDK defaults to responseStyle "fields", which wraps every payload as
  // { data, request, response }. Reading session.id / result.parts off that
  // envelope yields undefined, and because a failed call resolves to
  // { error, ... } instead of throwing, the turn silently "succeeded" with an
  // empty message. "data" unwraps the payload; throwOnError makes failures
  // reach the catch below instead of being reported as an empty result.
  const client = createOpencodeClient({
    baseUrl: server.baseUrl,
    responseStyle: "data",
    throwOnError: true
  });
  let progressSubscription = null;

  try {
    let session;
    if (sessionId) {
      emitProgress(onProgress, `Resuming session ${sessionId}.`, "starting", { threadId: sessionId });
      session = { id: sessionId };
    } else {
      session = await client.session.create({ body: { title: buildSessionTitle(prompt) } });
      emitProgress(onProgress, `Session ready (${session.id}).`, "starting", { threadId: session.id });
    }

    progressSubscription = streamProgress(client, onProgress);

    let result = null;
    let failure = null;
    try {
      result = await client.session.prompt({
        path: { id: session.id },
        body: {
          model: { providerID: PROVIDER_ID, modelID: modelId },
          parts: [{ type: "text", text: prompt }]
        }
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      progressSubscription.stop();
    }

    if (failure) {
      emitProgress(onProgress, `opencode error: ${failure}`, "failed");
      return {
        status: 1,
        threadId: session.id,
        turnId: null,
        finalMessage: "",
        error: { message: failure },
        stderr: server.getStderr()
      };
    }

    const finalMessage = extractFinalText(result);
    emitProgress(onProgress, "Turn completed.", "finalizing");

    return {
      status: 0,
      threadId: session.id,
      turnId: result.info?.id ?? null,
      finalMessage,
      error: null,
      stderr: server.getStderr()
    };
  } finally {
    await server.stop();
    // Only safe to await here, after the server is stopped: streamProgress's
    // for-await loop may be blocked awaiting the next SSE event, and nothing
    // else would ever unblock it — killing the server drops that connection
    // and lets `done` resolve instead of leaving it a dangling promise.
    await progressSubscription?.done;
  }
}

export async function abortOpencodeSession(baseUrl, sessionId) {
  if (!baseUrl || !sessionId) {
    return { attempted: false, interrupted: false, detail: "missing baseUrl or sessionId" };
  }
  try {
    // Same envelope problem as runOpencodeTurn: without responseStyle "data"
    // this resolves to an always-truthy { data, request, response } object, so
    // Boolean(interrupted) could never be false. Unwrapping makes the flag
    // reflect the body. Note that opencode 1.17.13 answers every abort with
    // 200 true, even for a session id that does not exist, so this only starts
    // reporting real outcomes once the server distinguishes them.
    const client = createOpencodeClient({ baseUrl, responseStyle: "data", throwOnError: true });
    const interrupted = await client.session.abort({ path: { id: sessionId } });
    return { attempted: true, interrupted: Boolean(interrupted), detail: null };
  } catch (error) {
    return { attempted: true, interrupted: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "selfhost did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
