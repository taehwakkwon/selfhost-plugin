import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";
import { resolveReviewTarget, collectReviewContext } from "./git.mjs";

function initRepo() {
  const dir = createTempDir("sgl-git-test-");
  runCommandChecked("git", ["init", "-q", "-b", "main"], { cwd: dir });
  runCommandChecked("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  runCommandChecked("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n", "utf8");
  runCommandChecked("git", ["add", "a.txt"], { cwd: dir });
  runCommandChecked("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

test("resolveReviewTarget picks working-tree when the tree is dirty", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
  const target = resolveReviewTarget(dir);
  assert.equal(target.mode, "working-tree");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectReviewContext inlines a small diff and lists changed files", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n", "utf8");
  const target = resolveReviewTarget(dir);
  const context = collectReviewContext(dir, target);
  assert.equal(context.inputMode, "inline-diff");
  assert.deepEqual(context.changedFiles, ["a.txt"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("collectReviewContext falls back to self-collect above the inline file budget", () => {
  const dir = initRepo();
  fs.writeFileSync(path.join(dir, "b.txt"), "new file\n", "utf8");
  fs.writeFileSync(path.join(dir, "c.txt"), "another new file\n", "utf8");
  fs.writeFileSync(path.join(dir, "d.txt"), "yet another\n", "utf8");
  const target = resolveReviewTarget(dir);
  const context = collectReviewContext(dir, target, { maxInlineFiles: 2 });
  assert.equal(context.inputMode, "self-collect");
  assert.match(context.collectionGuidance, /read.*tool/);
  assert.deepEqual(context.changedFiles.sort(), ["b.txt", "c.txt", "d.txt"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
