import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

test("a models map in the config file replaces the defaults instead of merging", async () => {
  await withTempConfigDir(async (dir) => {
    const mod = `./config.mjs?t=${Date.now()}-4`;
    const { loadSelfhostConfig, resolveModelId } = await import(mod);
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ version: 1, models: { glm: "GLM-5.2-FP8" } })
    );

    const config = loadSelfhostConfig();
    assert.deepEqual(Object.keys(config.models), ["glm"]);
    // The removed alias must NOT come back from the defaults; it falls through
    // resolveModelId's unknown-id passthrough instead.
    assert.equal(resolveModelId(config, "kimi"), "kimi");
    // Scalars still fall back to the defaults.
    assert.equal(config.apiKeyEnv, "CLIENT_KEY");
  });
});

test("an explicitly empty models map means no aliases at all", async () => {
  await withTempConfigDir(async (dir) => {
    const { loadSelfhostConfig, resolveModelId } = await import(`./config.mjs?t=${Date.now()}-5`);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1, models: {} }));

    const config = loadSelfhostConfig();
    assert.deepEqual(config.models, {});
    assert.equal(resolveModelId(config, "glm"), "glm");
  });
});

test("a config file without a models key still gets the default aliases", async () => {
  await withTempConfigDir(async (dir) => {
    const { loadSelfhostConfig } = await import(`./config.mjs?t=${Date.now()}-6`);
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ version: 1 }));
    assert.equal(loadSelfhostConfig().models.glm, "GLM-5.2-FP8");
  });
});

test("updateSelfhostConfig writes only touched keys, not the merged defaults", async () => {
  await withTempConfigDir(async (dir) => {
    const { updateSelfhostConfig } = await import(`./config.mjs?t=${Date.now()}-7`);
    const configFile = path.join(dir, "config.json");

    updateSelfhostConfig((config) => {
      config.structuredOutputSupported = false;
    });

    const written = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.deepEqual(Object.keys(written), ["structuredOutputSupported"]);
    // The whole point: an untouched default must not be frozen into the file,
    // because once it is there the user can never remove it.
    assert.equal(Object.prototype.hasOwnProperty.call(written, "models"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(written, "baseUrl"), false);
  });
});

test("updateSelfhostConfig preserves keys the user already had on disk", async () => {
  await withTempConfigDir(async (dir) => {
    const { updateSelfhostConfig } = await import(`./config.mjs?t=${Date.now()}-8`);
    const configFile = path.join(dir, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, baseUrl: "https://mine.example/v1" }));

    updateSelfhostConfig((config) => {
      config.structuredOutputSupported = true;
    });

    const written = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(written.baseUrl, "https://mine.example/v1");
    assert.equal(written.structuredOutputSupported, true);
    assert.equal(Object.prototype.hasOwnProperty.call(written, "models"), false);
  });
});

test("updateSelfhostConfig returns the full merged config, not the trimmed file", async () => {
  await withTempConfigDir(async () => {
    const { updateSelfhostConfig } = await import(`./config.mjs?t=${Date.now()}-9`);
    // buildSetupReport reuses this return value to probe the gateway, so it has
    // to carry baseUrl/apiKeyEnv even though neither is written to disk.
    const returned = updateSelfhostConfig((config) => {
      config.structuredOutputSupported = false;
    });
    assert.equal(returned.apiKeyEnv, "CLIENT_KEY");
    assert.ok(returned.baseUrl);
    assert.equal(returned.structuredOutputSupported, false);
  });
});

test("adding an alias persists the whole resulting map, defaults included", async () => {
  await withTempConfigDir(async (dir) => {
    const { updateSelfhostConfig, loadSelfhostConfig } = await import(`./config.mjs?t=${Date.now()}-10`);
    updateSelfhostConfig((config) => {
      config.models.custom = "some-model-id";
    });

    const written = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    assert.equal(written.models.custom, "some-model-id");
    // Deliberate: once `models` is touched it becomes authoritative, so the
    // seeded aliases have to be written alongside the new one. Writing only the
    // delta would silently drop them on the next load.
    assert.equal(written.models.glm, "GLM-5.2-FP8");
    assert.deepEqual(loadSelfhostConfig().models, written.models);
  });
});
