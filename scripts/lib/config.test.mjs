import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createTempDir } from "./fs.mjs";

async function withTempConfigDir(fn) {
  const dir = createTempDir("sgl-config-test-");
  process.env.SGL_CONFIG_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    delete process.env.SGL_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("loadSglConfig returns defaults when no config file exists", async () => {
  await withTempConfigDir(async () => {
    const { loadSglConfig, DEFAULT_SGL_CONFIG } = await import(`./config.mjs?t=${Date.now()}-1`);
    const config = loadSglConfig();
    assert.equal(config.baseUrl, DEFAULT_SGL_CONFIG.baseUrl);
    assert.equal(config.models.glm, "GLM-5.2-FP8");
  });
});

test("saveSglConfig then loadSglConfig round-trips an override", async () => {
  await withTempConfigDir(async () => {
    const { loadSglConfig, saveSglConfig } = await import(`./config.mjs?t=${Date.now()}-2`);
    const config = loadSglConfig();
    config.baseUrl = "https://example.internal/v1";
    saveSglConfig(config);
    assert.equal(loadSglConfig().baseUrl, "https://example.internal/v1");
  });
});

test("resolveModelId resolves known aliases and passes through unknown ids", async () => {
  await withTempConfigDir(async () => {
    const { loadSglConfig, resolveModelId } = await import(`./config.mjs?t=${Date.now()}-3`);
    const config = loadSglConfig();
    assert.equal(resolveModelId(config, "glm"), "GLM-5.2-FP8");
    assert.equal(resolveModelId(config, "dsv4"), "deepseek-ai/DeepSeek-V4-Flash");
    assert.equal(resolveModelId(config, undefined), "GLM-5.2-FP8");
    assert.equal(resolveModelId(config, "some-other-model-id"), "some-other-model-id");
  });
});
