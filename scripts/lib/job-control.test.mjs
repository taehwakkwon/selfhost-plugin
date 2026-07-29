import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { upsertJob } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { buildStatusSnapshot, buildSingleJobSnapshot, resolveCancelableJob, enrichJob } from "./job-control.mjs";

// resolveCancelableJob scopes active jobs to the current Claude Code session via
// SESSION_ID_ENV, and getCurrentSessionId falls back to process.env. Any shell
// running inside Claude Code has that variable set, which filters out these
// fixtures' session-less jobs and makes the suite's result depend on where it
// runs. Pin it off so each test exercises the branch it names.
let savedSessionId;

beforeEach(() => {
  savedSessionId = process.env[SESSION_ID_ENV];
  delete process.env[SESSION_ID_ENV];
});

afterEach(() => {
  if (savedSessionId === undefined) {
    delete process.env[SESSION_ID_ENV];
  } else {
    process.env[SESSION_ID_ENV] = savedSessionId;
  }
});

function initRepo() {
  const dir = createTempDir("selfhost-job-control-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("buildStatusSnapshot reports the per-job session runtime", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("selfhost-plugin-data-");
  const snapshot = buildStatusSnapshot(dir);
  assert.equal(snapshot.sessionRuntime.mode, "per-job");
  assert.deepEqual(snapshot.running, []);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("enrichJob infers 'starting' phase from an opencode server-ready log line", () => {
  const job = { id: "task-1", status: "running", jobClass: "task", startedAt: new Date().toISOString() };
  const enriched = enrichJob({ ...job, logFile: null });
  assert.equal(enriched.phase, "running");
});

test("buildSingleJobSnapshot throws a helpful error for an unknown job id", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("selfhost-plugin-data-");
  assert.throws(() => buildSingleJobSnapshot(dir, "nonexistent"), /No job found for "nonexistent"/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveCancelableJob throws when there is nothing active to cancel", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("selfhost-plugin-data-");
  assert.throws(() => resolveCancelableJob(dir, ""), /No active selfhost jobs to cancel/);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveCancelableJob finds the single active job when one is running", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("selfhost-plugin-data-");
  upsertJob(dir, { id: "task-1", status: "running" });
  const { job } = resolveCancelableJob(dir, "");
  assert.equal(job.id, "task-1");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveCancelableJob only considers jobs from the current session", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("selfhost-plugin-data-");
  process.env[SESSION_ID_ENV] = "session-a";
  upsertJob(dir, { id: "task-mine", status: "running", sessionId: "session-a" });
  upsertJob(dir, { id: "task-theirs", status: "running", sessionId: "session-b" });

  const { job } = resolveCancelableJob(dir, "");
  assert.equal(job.id, "task-mine");

  // A job id given explicitly bypasses session scoping, so another session's
  // job stays cancelable by reference.
  assert.equal(resolveCancelableJob(dir, "task-theirs").job.id, "task-theirs");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveCancelableJob says so when the only active job is another session's", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("selfhost-plugin-data-");
  process.env[SESSION_ID_ENV] = "session-a";
  upsertJob(dir, { id: "task-theirs", status: "running", sessionId: "session-b" });

  assert.throws(() => resolveCancelableJob(dir, ""), /No active selfhost jobs to cancel for this session\./);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
