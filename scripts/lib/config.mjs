import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./fs.mjs";

const CONFIG_DIR_ENV = "SELFHOST_CONFIG_DIR";

export const DEFAULT_SELFHOST_CONFIG = {
  version: 1,
  baseUrl: "https://gateway.post-train.win/v1",
  apiKeyEnv: "CLIENT_KEY",
  defaultModelAlias: "glm",
  models: {
    glm: "GLM-5.2-FP8",
    dsv4: "deepseek-ai/DeepSeek-V4-Flash"
  },
  structuredOutputSupported: null
};

export function resolveConfigDir() {
  return process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), ".claude", "selfhost");
}

export function resolveConfigFile() {
  return path.join(resolveConfigDir(), "config.json");
}

export function loadSelfhostConfig() {
  const configFile = resolveConfigFile();
  if (!fs.existsSync(configFile)) {
    return { ...DEFAULT_SELFHOST_CONFIG, models: { ...DEFAULT_SELFHOST_CONFIG.models } };
  }

  try {
    const parsed = readJsonFile(configFile);
    return {
      ...DEFAULT_SELFHOST_CONFIG,
      ...parsed,
      models: {
        ...DEFAULT_SELFHOST_CONFIG.models,
        ...(parsed.models ?? {})
      }
    };
  } catch {
    return { ...DEFAULT_SELFHOST_CONFIG, models: { ...DEFAULT_SELFHOST_CONFIG.models } };
  }
}

export function saveSelfhostConfig(config) {
  fs.mkdirSync(resolveConfigDir(), { recursive: true });
  writeJsonFile(resolveConfigFile(), config);
  return config;
}

export function updateSelfhostConfig(mutate) {
  const config = loadSelfhostConfig();
  mutate(config);
  return saveSelfhostConfig(config);
}

export function resolveModelId(config, aliasOrId) {
  if (!aliasOrId) {
    const defaultAlias = config.defaultModelAlias;
    return config.models[defaultAlias] ?? defaultAlias;
  }
  return config.models[aliasOrId] ?? aliasOrId;
}
