import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "SELFHOST_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

export function redactSecrets(text, secrets = []) {
  let result = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

// Deep variant for arbitrary execution payloads (rescue vs. review jobs
// have different shapes) — redacts every string leaf and preserves the
// original structure, so `result: execution.payload` in a job's persisted
// JSON record can't carry a secret in a field nobody thought to name.
export function redactSecretsDeep(value, secrets = []) {
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item, secrets));
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = redactSecretsDeep(val, secrets);
    }
    return result;
  }
  return value;
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      serverBaseUrl:
        typeof value.serverBaseUrl === "string" && value.serverBaseUrl.trim() ? value.serverBaseUrl.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    serverBaseUrl: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message, secrets = []) {
  const normalized = redactSecrets(String(message ?? "").trim(), secrets);
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body, secrets = []) {
  if (!logFile || !body) {
    return;
  }
  const normalized = redactSecrets(String(body).trimEnd(), secrets);
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${normalized}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastServerBaseUrl = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.serverBaseUrl && normalized.serverBaseUrl !== lastServerBaseUrl) {
      lastServerBaseUrl = normalized.serverBaseUrl;
      patch.serverBaseUrl = normalized.serverBaseUrl;
      changed = true;
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null, secrets = [] } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = redactSecrets(event.stderrMessage ?? event.message, secrets);
    if (stderr && stderrMessage) {
      process.stderr.write(`[selfhost] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message, secrets);
    appendLogBlock(logFile, event.logTitle, event.logBody, secrets);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    // Redact once and reuse the same value for the state file and the log
    // file — writing the raw string to one and the redacted string to the
    // other left a secret sitting in the JSON job record even after the
    // log file itself was fixed.
    const redactedRendered = redactSecrets(String(execution.rendered ?? ""), options.secrets ?? []);
    const redactedPayload = redactSecretsDeep(execution.payload, options.secrets ?? []);
    const redactedSummary = redactSecrets(String(execution.summary ?? ""), options.secrets ?? []);
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      serverBaseUrl: null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: redactedPayload,
      rendered: redactedRendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      serverBaseUrl: null,
      summary: redactedSummary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", redactedRendered);
    return execution;
  } catch (error) {
    const errorMessage = redactSecrets(
      error instanceof Error ? error.message : String(error),
      options.secrets ?? []
    );
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    // Rethrow the redacted message, not the original `error` — the caller
    // (and selfhost-companion.mjs's top-level main().catch, which prints
    // error.message to stderr unredacted) would otherwise leak whatever
    // this function just redacted for disk. A server-start failure that
    // echoes a secret into its own stderr (opencode.mjs's "opencode serve
    // exited before becoming ready: ${stderr}") is exactly the shape that
    // reaches here.
    throw new Error(errorMessage);
  }
}
