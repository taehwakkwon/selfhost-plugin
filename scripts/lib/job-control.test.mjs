import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { upsertJob } from "./state.mjs";
import { buildStatusSnapshot, buildSingleJobSnapshot, resolveCancelableJob, enrichJob } from "./job-control.mjs";

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
