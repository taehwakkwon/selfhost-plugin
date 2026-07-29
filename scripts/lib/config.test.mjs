import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";

async function withTempConfigDir(fn) {
  const dir = createTempDir("selfhost-config-test-");
  process.env.SELFHOST_CONFIG_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    delete process.env.SELFHOST_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSelfhostConfig returns defaults when no config file exists", async () => {
  await withTempConfigDir(async () => {
    const { loadSelfhostConfig, DEFAULT_SELFHOST_CONFIG } = await import(`./config.mjs?t=${Date.now()}-1`);
    const config = loadSelfhostConfig();
    assert.equal(config.baseUrl, DEFAULT_SELFHOST_CONFIG.baseUrl);
    assert.equal(config.models.glm, "GLM-5.2-FP8");
  });
});

test("saveSelfhostConfig then loadSelfhostConfig round-trips an override", async () => {
  await withTempConfigDir(async () => {
    const { loadSelfhostConfig, saveSelfhostConfig } = await import(`./config.mjs?t=${Date.now()}-2`);
    const config = loadSelfhostConfig();
    config.baseUrl = "https://example.internal/v1";
    saveSelfhostConfig(config);
    assert.equal(loadSelfhostConfig().baseUrl, "https://example.internal/v1");
  });
});

test("resolveModelId resolves known aliases and passes through unknown ids", async () => {
  await withTempConfigDir(async () => {
    const { loadSelfhostConfig, resolveModelId } = await import(`./config.mjs?t=${Date.now()}-3`);
    const config = loadSelfhostConfig();
    assert.equal(resolveModelId(config, "glm"), "GLM-5.2-FP8");
    assert.equal(resolveModelId(config, "kimi"), "kimi-k3");
    assert.equal(resolveModelId(config, undefined), "GLM-5.2-FP8");
    assert.equal(resolveModelId(config, "some-other-model-id"), "some-other-model-id");
  });
});
