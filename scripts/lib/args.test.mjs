import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "./args.mjs";

test("parseArgs splits booleans, values, and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--background", "--model", "glm", "fix", "the", "bug"],
    { valueOptions: ["model"], booleanOptions: ["background"] }
  );
  assert.equal(options.background, true);
  assert.equal(options.model, "glm");
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("parseArgs applies alias map to short flags", () => {
  const { options } = parseArgs(["-m", "kimi"], {
    valueOptions: ["model"],
    aliasMap: { m: "model" }
  });
  assert.equal(options.model, "kimi");
});

test("splitRawArgumentString respects quotes", () => {
  const tokens = splitRawArgumentString(`--model glm "fix the flaky test"`);
  assert.deepEqual(tokens, ["--model", "glm", "fix the flaky test"]);
});
