import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import {
  redactSecrets,
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  runTrackedJob
} from "./tracked-jobs.mjs";
import { listJobs, readJobFile, resolveJobFile } from "./state.mjs";

function initRepo() {
  const dir = createTempDir("sgl-tracked-jobs-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("redactSecrets strips every occurrence of a secret value", () => {
  const text = redactSecrets("Authorization: Bearer sk-abc123 (token sk-abc123)", ["sk-abc123"]);
  assert.equal(text, "Authorization: Bearer [REDACTED] (token [REDACTED])");
});

test("appendLogLine redacts secrets before writing to the log file", () => {
  const dir = createTempDir("sgl-log-test-");
  const logFile = `${dir}/job.log`;
  fs.writeFileSync(logFile, "", "utf8");
  appendLogLine(logFile, "using token sk-abc123", ["sk-abc123"]);
  const contents = fs.readFileSync(logFile, "utf8");
  assert.doesNotMatch(contents, /sk-abc123/);
  assert.match(contents, /\[REDACTED\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createJobProgressUpdater persists serverBaseUrl onto the job record", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const logFile = createJobLogFile(dir, "task-1", "Test job");
  const update = createJobProgressUpdater(dir, "task-1");
  update({ message: "server ready", phase: "starting", serverBaseUrl: "http://127.0.0.1:5555" });
  const [job] = listJobs(dir);
  assert.equal(job.serverBaseUrl, "http://127.0.0.1:5555");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
  void logFile;
});

test("runTrackedJob records a completed job and clears serverBaseUrl", async () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const job = { id: "task-2", workspaceRoot: dir, title: "Test job" };
  await runTrackedJob(job, async () => ({
    exitStatus: 0,
    threadId: "session-abc",
    turnId: "msg-1",
    payload: { ok: true },
    rendered: "done",
    summary: "Test job finished"
  }));
  const [stored] = listJobs(dir);
  assert.equal(stored.status, "completed");
  assert.equal(stored.threadId, "session-abc");
  assert.equal(stored.serverBaseUrl, null);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("runTrackedJob redacts secrets from rendered output written to the job log file", async () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const logFile = createJobLogFile(dir, "task-3", "Test job");
  const job = { id: "task-3", workspaceRoot: dir, title: "Test job", logFile };
  const secret = "sk-live-super-secret-token";
  await runTrackedJob(
    job,
    async () => ({
      exitStatus: 0,
      threadId: "session-abc",
      turnId: "msg-1",
      payload: { ok: true },
      rendered: `Response used token ${secret} to authenticate`,
      summary: "Test job finished"
    }),
    { secrets: [secret] }
  );
  const contents = fs.readFileSync(logFile, "utf8");
  assert.doesNotMatch(contents, new RegExp(secret));
  assert.match(contents, /\[REDACTED\]/);
  // The persisted JSON job record must carry the same redacted value as the
  // log file, not the raw rendered output.
  const storedJob = readJobFile(resolveJobFile(dir, "task-3"));
  assert.doesNotMatch(storedJob.rendered, new RegExp(secret));
  assert.match(storedJob.rendered, /\[REDACTED\]/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("runTrackedJob redacts secrets from a thrown error message before storing it", async () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-plugin-data-");
  const logFile = createJobLogFile(dir, "task-4", "Test job");
  const job = { id: "task-4", workspaceRoot: dir, title: "Test job", logFile };
  const secret = "sk-live-super-secret-token";
  await assert.rejects(
    runTrackedJob(
      job,
      async () => {
        throw new Error(`Authorization failed: Bearer ${secret}`);
      },
      { secrets: [secret] }
    )
  );
  const [stored] = listJobs(dir);
  assert.doesNotMatch(stored.errorMessage, new RegExp(secret));
  assert.match(stored.errorMessage, /\[REDACTED\]/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
