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
import { listJobs } from "./state.mjs";

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
