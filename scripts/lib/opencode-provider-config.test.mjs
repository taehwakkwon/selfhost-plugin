import test from "node:test";
import assert from "node:assert/strict";

import { buildOpencodeConfig, PROVIDER_ID } from "./opencode-provider-config.mjs";

const SAMPLE_CONFIG = {
  baseUrl: "https://gateway.post-train.win/v1",
  apiKeyEnv: "CLIENT_KEY",
  models: {
    glm: "GLM-5.2-FP8",
    dsv4: "deepseek-ai/DeepSeek-V4-Flash"
  }
};

test("buildOpencodeConfig registers the gateway as an openai-compatible provider", () => {
  const config = buildOpencodeConfig(SAMPLE_CONFIG, "rescue");
  const provider = config.provider[PROVIDER_ID];
  assert.equal(provider.npm, "@ai-sdk/openai-compatible");
  assert.equal(provider.options.baseURL, "https://gateway.post-train.win/v1");
  assert.equal(provider.options.apiKey, "{env:CLIENT_KEY}");
  assert.deepEqual(Object.keys(provider.models).sort(), ["GLM-5.2-FP8", "deepseek-ai/DeepSeek-V4-Flash"].sort());
});

test("rescue profile allows edit and bash", () => {
  const config = buildOpencodeConfig(SAMPLE_CONFIG, "rescue");
  assert.deepEqual(config.permission, { edit: "allow", bash: "allow" });
});

test("review profile denies edit and bash", () => {
  const config = buildOpencodeConfig(SAMPLE_CONFIG, "review");
  assert.deepEqual(config.permission, { edit: "deny", bash: "deny" });
});

test("throws on unknown permission profile", () => {
  assert.throws(() => buildOpencodeConfig(SAMPLE_CONFIG, "bogus"), /Unknown permission profile/);
});

test("throws when baseUrl is missing", () => {
  assert.throws(() => buildOpencodeConfig({ ...SAMPLE_CONFIG, baseUrl: null }, "rescue"), /No gateway base URL configured/);
});
