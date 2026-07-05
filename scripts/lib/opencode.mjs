import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { createTempDir, writeJsonFile } from "./fs.mjs";
import { binaryAvailable, terminateProcessTree } from "./process.mjs";
import { buildOpencodeConfig } from "./opencode-provider-config.mjs";

const READY_TIMEOUT_MS = 15000;
const READY_POLL_INTERVAL_MS = 200;

export function getOpencodeAvailability(cwd) {
  return binaryAvailable("opencode", ["--version"], { cwd });
}

export function getSessionRuntimeStatus() {
  return {
    mode: "per-job",
    label: "per-job runtime",
    detail: "Each sgl job starts its own opencode server on an ephemeral port and tears it down when the job finishes.",
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
      const response = await fetch(`http://127.0.0.1:${port}/doc`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not accepting connections yet; keep polling until the deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`opencode serve did not become ready on port ${port} within ${READY_TIMEOUT_MS}ms.`);
}

export async function startOpencodeServer(sglConfig, permissionProfile) {
  const configDir = createTempDir("sgl-opencode-config-");
  const configFile = path.join(configDir, "opencode.json");
  writeJsonFile(configFile, buildOpencodeConfig(sglConfig, permissionProfile));

  const port = await findFreePort();
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    env: { ...process.env, OPENCODE_CONFIG: configFile },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await Promise.race([
      waitForReady(port, Date.now() + READY_TIMEOUT_MS),
      exitPromise.then((exit) => {
        throw new Error(
          `opencode serve exited before becoming ready (code=${exit.code}, signal=${exit.signal}): ${stderr.trim()}`
        );
      })
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
