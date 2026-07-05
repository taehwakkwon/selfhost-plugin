import test from "node:test";
import assert from "node:assert/strict";

import { binaryAvailable, terminateProcessTree, formatCommandFailure } from "./process.mjs";

test("binaryAvailable reports unavailable for a nonexistent command", () => {
  const result = binaryAvailable("definitely-not-a-real-binary-xyz");
  assert.equal(result.available, false);
  assert.equal(result.detail, "not found");
});

test("binaryAvailable reports available for node itself", () => {
  const result = binaryAvailable("node", ["--version"]);
  assert.equal(result.available, true);
  assert.match(result.detail, /^v\d+\.\d+\.\d+/);
});

test("terminateProcessTree no-ops on a non-finite pid", () => {
  const result = terminateProcessTree(Number.NaN);
  assert.deepEqual(result, { attempted: false, delivered: false, method: null });
});

test("formatCommandFailure includes command, exit code, and stderr", () => {
  const message = formatCommandFailure({
    command: "git",
    args: ["status"],
    status: 128,
    signal: null,
    stdout: "",
    stderr: "fatal: not a git repository"
  });
  assert.match(message, /git status/);
  assert.match(message, /exit=128/);
  assert.match(message, /fatal: not a git repository/);
});
