import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { getOpencodeAvailability, getSessionRuntimeStatus, findFreePort } from "./opencode.mjs";

test("getOpencodeAvailability reports unavailable when opencode is not installed", () => {
  const result = getOpencodeAvailability(process.cwd());
  if (result.available) {
    // opencode happens to be installed in this environment; just check the shape.
    assert.equal(typeof result.detail, "string");
  } else {
    assert.equal(result.detail, "not found");
  }
});

test("getSessionRuntimeStatus always reports the per-job model", () => {
  const status = getSessionRuntimeStatus();
  assert.equal(status.mode, "per-job");
  assert.equal(status.endpoint, null);
});

test("findFreePort returns a port that is actually free", async () => {
  const port = await findFreePort();
  assert.ok(port > 0 && port < 65536);
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
});
