import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createTempDir, readJsonFile, writeJsonFile, isProbablyText } from "./fs.mjs";

test("writeJsonFile then readJsonFile round-trips", () => {
  const dir = createTempDir("selfhost-fs-test-");
  const file = path.join(dir, "config.json");
  writeJsonFile(file, { hello: "world" });
  assert.deepEqual(readJsonFile(file), { hello: "world" });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("isProbablyText rejects buffers with null bytes", () => {
  assert.equal(isProbablyText(Buffer.from("hello")), true);
  assert.equal(isProbablyText(Buffer.from([0x68, 0x00, 0x69])), false);
});
