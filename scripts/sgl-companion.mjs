#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { loadSglConfig, updateSglConfig, resolveModelId } from "./lib/config.mjs";
import {
  getOpencodeAvailability,
  getSessionRuntimeStatus,
  runOpencodeTurn,
  abortOpencodeSession,
  parseStructuredOutput,
  readOutputSchema
} from "./lib/opencode.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  redactSecrets,
  redactSecretsDeep,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderPlainReviewResult,
  renderReviewResult,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const DEFAULT_CONTINUE_PROMPT = "Continue the previous task.";
const GATEWAY_PROBE_TIMEOUT_MS = 15000;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/sgl-companion.mjs setup [--base-url <url>] [--api-key-env <name>] [--model <alias>=<id>] [--default-model <alias>] [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/sgl-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/sgl-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/sgl-companion.mjs task [--background] [--resume-last|--resume|--fresh] [--model <alias>] [prompt]",
      "  node scripts/sgl-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/sgl-companion.mjs result [job-id] [--json]",
      "  node scripts/sgl-companion.mjs cancel [job-id] [--json]",
      "  node scripts/sgl-companion.mjs stop-review [--json] [claude response text]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      m: "model",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function probeGatewayReachability(sglConfig) {
  const token = process.env[sglConfig.apiKeyEnv];
  if (!token) {
    return { available: false, detail: `Environment variable ${sglConfig.apiKeyEnv} is not set.` };
  }
  const defaultModelId = resolveModelId(sglConfig, undefined);
  try {
    const response = await fetch(`${sglConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: defaultModelId, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      return { available: false, detail: `Gateway responded with HTTP ${response.status}.` };
    }
    return { available: true, detail: `Reachable at ${sglConfig.baseUrl} (model ${defaultModelId}).` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function probeStructuredOutputSupport(sglConfig) {
  const token = process.env[sglConfig.apiKeyEnv];
  if (!token) {
    return null;
  }
  const defaultModelId = resolveModelId(sglConfig, undefined);
  try {
    const response = await fetch(`${sglConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: defaultModelId,
        messages: [{ role: "user", content: "Reply with JSON matching the schema." }],
        max_tokens: 32,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "probe",
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }
          }
        }
      }),
      signal: AbortSignal.timeout(GATEWAY_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content ?? "";
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const opencodeStatus = getOpencodeAvailability(cwd);
  let sglConfig = loadSglConfig();
  const gateway = await probeGatewayReachability(sglConfig);

  const nextSteps = [];
  if (!opencodeStatus.available) {
    nextSteps.push("Install opencode (see https://opencode.ai) so /sgl:rescue and /sgl:review have an execution engine.");
  }
  if (!gateway.available) {
    nextSteps.push(`Fix gateway connectivity: ${gateway.detail}`);
  }

  let structuredOutput = { available: sglConfig.structuredOutputSupported, detail: "not probed" };
  if (opencodeStatus.available && gateway.available) {
    const supported = await probeStructuredOutputSupport(sglConfig);
    sglConfig = updateSglConfig((config) => {
      config.structuredOutputSupported = supported;
    });
    structuredOutput = {
      available: supported,
      // adversarial-review always parses leniently regardless of this probe
      // result (see parseStructuredOutput) — this is diagnostic information
      // about how often that fallback path is likely to trigger, not a
      // report of different behavior the plugin takes based on the flag.
      detail: supported
        ? "the gateway honored a response_format: json_schema request during setup"
        : "the gateway did not honor response_format: json_schema during setup — expect adversarial-review's lenient-parse fallback to trigger more often"
    };
  }

  const config = getConfig(workspaceRoot);

  return {
    ready: nodeStatus.available && opencodeStatus.available && gateway.available,
    node: nodeStatus,
    opencode: opencodeStatus,
    gateway,
    structuredOutput,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "base-url", "api-key-env", "default-model", "model"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["base-url"] || options["api-key-env"] || options["default-model"] || options.model) {
    updateSglConfig((config) => {
      if (options["base-url"]) {
        config.baseUrl = options["base-url"];
        actionsTaken.push(`Set gateway base URL to ${options["base-url"]}.`);
      }
      if (options["api-key-env"]) {
        config.apiKeyEnv = options["api-key-env"];
        actionsTaken.push(`Set API key env var name to ${options["api-key-env"]}.`);
      }
      if (options.model) {
        const [alias, modelId] = String(options.model).split("=", 2);
        if (!alias || !modelId) {
          throw new Error('--model must be in the form --model <alias>=<model-id>, e.g. --model glm=GLM-5.2-FP8');
        }
        config.models = { ...config.models, [alias]: modelId };
        actionsTaken.push(`Registered model alias "${alias}" -> "${modelId}".`);
      }
      if (options["default-model"]) {
        config.defaultModelAlias = options["default-model"];
        actionsTaken.push(`Set default model alias to ${options["default-model"]}.`);
      }
    });
  }

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function ensureOpencodeAvailable(cwd) {
  const availability = getOpencodeAvailability(cwd);
  if (!availability.available) {
    throw new Error("opencode CLI is not installed. Install it (see https://opencode.ai), then rerun `/sgl:setup`.");
  }
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "sgl Review" : `sgl ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "sgl Resume" : "sgl Rescue";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

async function executeReviewRun(request) {
  ensureOpencodeAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  // `target` is resolved once by the caller (handleReviewCommand) and passed
  // in here — resolving it a second time was redundant work, and it also
  // meant the focus-text validation below used to live here instead of
  // before the job record was even created (see handleReviewCommand).
  const target = request.target;
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName;

  const context = collectReviewContext(request.cwd, target);
  const sglConfig = loadSglConfig();
  const modelId = resolveModelId(sglConfig, request.model);

  let prompt;
  if (reviewName === "Adversarial Review") {
    const outputSchemaJson = JSON.stringify(readOutputSchema(REVIEW_SCHEMA), null, 2);
    const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
    prompt = interpolateTemplate(template, {
      TARGET_LABEL: target.label,
      USER_FOCUS: focusText || "No extra focus provided.",
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      REVIEW_INPUT: context.content,
      OUTPUT_SCHEMA_JSON: outputSchemaJson
    });
  } else {
    const template = loadPromptTemplate(ROOT_DIR, "review");
    prompt = interpolateTemplate(template, {
      TARGET_LABEL: target.label,
      REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
      REVIEW_INPUT: context.content
    });
  }

  const result = await runOpencodeTurn(request.cwd, {
    sglConfig,
    permissionProfile: "review",
    modelId,
    prompt,
    onProgress: request.onProgress
  });

  if (reviewName === "Adversarial Review") {
    const parsed = parseStructuredOutput(result.finalMessage, {
      status: result.status,
      failureMessage: result.error?.message ?? result.stderr
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      context: { repoRoot: context.repoRoot, branch: context.branch, summary: context.summary },
      opencode: { status: result.status, stderr: result.stderr, stdout: result.finalMessage },
      result: parsed.parsed,
      rawOutput: parsed.rawOutput,
      parseError: parsed.parseError
    };
    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered: renderReviewResult(parsed, { reviewLabel: reviewName, targetLabel: target.label }),
      summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
      jobTitle: `sgl ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    opencode: { status: result.status, stderr: result.stderr, stdout: result.finalMessage }
  };
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderPlainReviewResult(result, { reviewLabel: reviewName, targetLabel: target.label }),
    summary: firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `sgl ${reviewName}`,
    jobClass: "review",
    targetLabel: target.label
  };
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) => job.jobClass === "task" && job.threadId && job.status !== "queued" && job.status !== "running"
    ) ?? null
  );
}

function resolveLatestTrackedTaskThread(workspaceRoot, options = {}) {
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find(
    (job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running")
  );
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /sgl:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  return trackedTask ? { id: trackedTask.threadId } : null;
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureOpencodeAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });

  let resumeSessionId = null;
  if (request.resumeLast) {
    const latestThread = resolveLatestTrackedTaskThread(workspaceRoot, { excludeJobId: request.jobId });
    if (!latestThread) {
      throw new Error("No previous sgl rescue session was found for this repository.");
    }
    resumeSessionId = latestThread.id;
  }

  if (!request.prompt && !resumeSessionId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const sglConfig = loadSglConfig();
  const modelId = resolveModelId(sglConfig, request.model);

  const result = await runOpencodeTurn(request.cwd, {
    sglConfig,
    permissionProfile: "rescue",
    modelId,
    prompt: request.prompt?.trim() || DEFAULT_CONTINUE_PROMPT,
    sessionId: resumeSessionId,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult({ rawOutput, failureMessage }, { title: taskMetadata.title, jobId: request.jobId ?? null });
  const payload = { status: result.status, threadId: result.threadId, rawOutput };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task"
  };
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: kind === "adversarial-review" ? "adversarial-review" : jobClass === "review" ? "review" : "rescue",
    title,
    workspaceRoot,
    jobClass,
    summary
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  const sglConfig = loadSglConfig();
  const secrets = [process.env[sglConfig.apiKeyEnv]].filter(Boolean);
  return {
    logFile,
    secrets,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      secrets,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, secrets, progress } = createTrackedProgress(job, { logFile: options.logFile, stderr: !options.json });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile, secrets });
  // runTrackedJob redacts the copies it persists to the job file/state, but returns the
  // original, unredacted execution object — so the CLI's own stdout here is a second write
  // path that must be redacted independently, or a secret surfacing in e.g. opencode's
  // stderr (carried in payload.opencode.stderr) would print straight to the terminal even
  // though the on-disk record was clean.
  const safePayload = redactSecretsDeep(execution.payload, secrets);
  const safeRendered = redactSecrets(String(execution.rendered ?? ""), secrets);
  outputResult(options.json ? safePayload : safeRendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "sgl-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", (error) => {
    // Spawn failures (EMFILE/EAGAIN, or `cwd` vanishing) emit 'error'
    // asynchronously, after this function has already returned control to
    // the caller — an unhandled listener here would crash the whole host
    // process (the same bug class opencode.mjs's startOpencodeServer was
    // fixed for in Task 7). Mark the job failed instead of leaving it
    // stuck in "queued" forever.
    try {
      const workspaceRoot = resolveWorkspaceRoot(cwd);
      upsertJob(workspaceRoot, {
        id: jobId,
        status: "failed",
        phase: "failed",
        pid: null,
        errorMessage: `Failed to start background worker: ${error.message}`,
        completedAt: nowIso()
      });
    } catch {
      // Best effort — if the job record can't be updated either, there's
      // nothing further to do from a detached spawn's error handler.
    }
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = { ...job, status: "queued", phase: "queued", pid: child.pid ?? null, logFile, request };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return { payload: { jobId: job.id, status: "queued", title: job.title, summary: job.summary, logFile }, logFile };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();

  // Validate before creating a job record — this used to throw from inside
  // executeReviewRun, which runs inside runTrackedJob, so an invalid
  // /sgl:review <text> call left a spurious "failed" job behind.
  if (config.reviewName === "Review" && focusText) {
    throw new Error(
      "`/sgl:review` does not support custom focus text. Retry with `/sgl:adversarial-review " + focusText + "` for focused review instructions."
    );
  }

  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });

  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        target,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd", "prompt-file"],
    booleanOptions: ["json", "resume-last", "resume", "fresh", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ") || readStdinIfPiped();

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  if (options.background) {
    ensureOpencodeAvailable(cwd);
    if (!prompt && !resumeLast) {
      throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
    }
    const job = createCompanionJob({
      prefix: "task",
      kind: "task",
      title: taskMetadata.title,
      workspaceRoot,
      jobClass: "task",
      summary: taskMetadata.summary
    });
    const request = { cwd, model: options.model, prompt, resumeLast, jobId: job.id };
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, `${payload.title} started in the background as ${payload.jobId}. Check /sgl:status ${payload.jobId} for progress.\n`, options.json);
    return;
  }

  const job = createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({ cwd, model: options.model, prompt, resumeLast, jobId: job.id, onProgress: progress }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd", "job-id"] });
  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }
  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, secrets, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  await runTrackedJob({ ...storedJob, workspaceRoot, logFile }, () => executeTaskRun({ ...request, onProgress: progress }), { logFile, secrets });
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while ((snapshot.job.status === "queued" || snapshot.job.status === "running") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return { ...snapshot, waitTimedOut: snapshot.job.status === "queued" || snapshot.job.status === "running", timeoutMs };
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, { timeoutMs: options["timeout-ms"], pollIntervalMs: options["poll-interval-ms"] })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputCommandResult({ job, storedJob }, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId: getCurrentClaudeSessionId(),
    candidate: candidate
      ? {
          id: candidate.id,
          status: candidate.status,
          title: candidate.title ?? null,
          summary: candidate.summary ?? null,
          threadId: candidate.threadId,
          completedAt: candidate.completedAt ?? null,
          updatedAt: candidate.updatedAt ?? null
        }
      : null
  };

  outputCommandResult(
    payload,
    candidate ? `Resumable task found: ${candidate.id} (${candidate.status}).\n` : "No resumable task found for this session.\n",
    options.json
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, { valueOptions: ["cwd"], booleanOptions: ["json"] });
  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const serverBaseUrl = existing.serverBaseUrl ?? job.serverBaseUrl ?? null;
  const threadId = existing.threadId ?? job.threadId ?? null;

  const abort = await abortOpencodeSession(serverBaseUrl, threadId);
  if (abort.attempted) {
    appendLogLine(
      job.logFile,
      abort.interrupted
        ? `Requested opencode session abort for ${threadId}.`
        : `opencode session abort failed${abort.detail ? `: ${abort.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." };
  writeJobFile(workspaceRoot, job.id, { ...existing, ...nextJob, cancelledAt: completedAt });
  upsertJob(workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, errorMessage: "Cancelled by user.", completedAt });

  outputCommandResult(
    { jobId: job.id, status: "cancelled", title: job.title, turnAbortAttempted: abort.attempted, turnAborted: abort.interrupted },
    renderCancelReport(nextJob),
    options.json
  );
}

async function executeStopReviewRun(request) {
  ensureOpencodeAvailable(request.cwd);
  const sglConfig = loadSglConfig();
  const modelId = resolveModelId(sglConfig, request.model);
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");

  // The "review" permission profile denies bash, so the model cannot run `git` itself here.
  // Collect a lightweight working-tree snapshot up front so it has something concrete to
  // ground an ALLOW/BLOCK decision on; it can still `read`/`grep`/`glob` for more detail.
  let repoContextBlock = "";
  try {
    ensureGitRepository(request.cwd);
    const target = resolveReviewTarget(request.cwd, { scope: "working-tree" });
    const context = collectReviewContext(request.cwd, target);
    repoContextBlock = `\n\nRepository context (you have no bash access; use read/grep/glob if you need more than this):\n\n${context.content}`;
  } catch {
    repoContextBlock = "";
  }

  const prompt = interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: `${request.claudeResponseBlock ?? ""}${repoContextBlock}`
  });

  const result = await runOpencodeTurn(request.cwd, {
    sglConfig,
    permissionProfile: "review",
    modelId,
    prompt,
    onProgress: request.onProgress
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload: { status: result.status, threadId: result.threadId, rawOutput },
    rendered: rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`,
    summary: firstMeaningfulLine(rawOutput, "Stop-gate review finished."),
    jobTitle: "sgl Stop Gate Review",
    jobClass: "review"
  };
}

async function handleStopReview(argv) {
  const { positionals, options } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const claudeResponseBlock = positionals.join(" ") || readStdinIfPiped();

  const job = createCompanionJob({
    prefix: "stopreview",
    kind: "stop-review",
    title: "sgl Stop Gate Review",
    workspaceRoot,
    jobClass: "review",
    summary: "Stop-gate review of previous Claude turn"
  });
  await runForegroundCommand(
    job,
    (progress) => executeStopReviewRun({ cwd, model: options.model, claudeResponseBlock, onProgress: progress }),
    { json: options.json }
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReviewCommand(argv, { reviewName: "Review" });
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, { reviewName: "Adversarial Review" });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "stop-review":
      await handleStopReview(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
