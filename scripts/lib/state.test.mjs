import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { upsertJob, listJobs, getConfig, setConfig, resolveStateDir } from "./state.mjs";

function initRepo() {
  const dir = createTempDir("sgl-state-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

test("upsertJob inserts then updates a job record", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-state-plugin-data-");
  upsertJob(dir, { id: "task-1", status: "running" });
  upsertJob(dir, { id: "task-1", status: "completed" });
  const jobs = listJobs(dir);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("setConfig/getConfig round-trips a config value", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-state-plugin-data-");
  setConfig(dir, "stopReviewGate", true);
  assert.equal(getConfig(dir).stopReviewGate, true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

test("resolveStateDir is stable for the same workspace root", () => {
  const dir = initRepo();
  process.env.CLAUDE_PLUGIN_DATA = createTempDir("sgl-state-plugin-data-");
  assert.equal(resolveStateDir(dir), resolveStateDir(dir));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});
