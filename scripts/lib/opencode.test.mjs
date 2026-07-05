import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  getOpencodeAvailability,
  getSessionRuntimeStatus,
  findFreePort,
  buildSessionTitle,
  extractFinalText,
  parseStructuredOutput
} from "./opencode.mjs";

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

test("buildSessionTitle truncates long prompts to 80 characters", () => {
  const long = "x".repeat(200);
  const title = buildSessionTitle(long);
  assert.equal(title.length, 80);
  assert.ok(title.endsWith("..."));
});

test("buildSessionTitle falls back to a default for empty prompts", () => {
  assert.equal(buildSessionTitle("   "), "sgl session");
});

test("extractFinalText joins text parts and ignores non-text parts", () => {
  const text = extractFinalText({
    parts: [
      { type: "text", text: "first line" },
      { type: "tool", text: "ignored" },
      { type: "text", text: "second line" }
    ]
  });
  assert.equal(text, "first line\nsecond line");
});

test("parseStructuredOutput parses valid JSON", () => {
  const result = parseStructuredOutput('{"verdict":"approve"}');
  assert.equal(result.parseError, null);
  assert.deepEqual(result.parsed, { verdict: "approve" });
});

test("parseStructuredOutput reports a parse error for invalid JSON without throwing", () => {
  const result = parseStructuredOutput("not json");
  assert.equal(result.parsed, null);
  assert.match(result.parseError, /Unexpected token|not valid JSON/i);
});

test("parseStructuredOutput reports a fallback message for empty output", () => {
  const result = parseStructuredOutput("", { failureMessage: "sgl returned nothing" });
  assert.equal(result.parseError, "sgl returned nothing");
});
