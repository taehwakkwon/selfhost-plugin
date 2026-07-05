import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./fs.mjs";

const CONFIG_DIR_ENV = "SGL_CONFIG_DIR";

export const DEFAULT_SGL_CONFIG = {
  version: 1,
  baseUrl: "https://gateway.example.com/v1",
  apiKeyEnv: "CLIENT_KEY",
  defaultModelAlias: "glm",
  models: {
    glm: "GLM-5.2-FP8",
    dsv4: "deepseek-ai/DeepSeek-V4-Flash"
  },
  structuredOutputSupported: null
};

export function resolveConfigDir() {
  return process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), ".claude", "sgl");
}

export function resolveConfigFile() {
  return path.join(resolveConfigDir(), "config.json");
}

export function loadSglConfig() {
  const configFile = resolveConfigFile();
  if (!fs.existsSync(configFile)) {
    return { ...DEFAULT_SGL_CONFIG, models: { ...DEFAULT_SGL_CONFIG.models } };
  }

  try {
    const parsed = readJsonFile(configFile);
    return {
      ...DEFAULT_SGL_CONFIG,
      ...parsed,
      models: {
        ...DEFAULT_SGL_CONFIG.models,
        ...(parsed.models ?? {})
      }
    };
  } catch {
    return { ...DEFAULT_SGL_CONFIG, models: { ...DEFAULT_SGL_CONFIG.models } };
  }
}

export function saveSglConfig(config) {
  fs.mkdirSync(resolveConfigDir(), { recursive: true });
  writeJsonFile(resolveConfigFile(), config);
  return config;
}

export function updateSglConfig(mutate) {
  const config = loadSglConfig();
  mutate(config);
  return saveSglConfig(config);
}

export function resolveModelId(config, aliasOrId) {
  if (!aliasOrId) {
    const defaultAlias = config.defaultModelAlias;
    return config.models[defaultAlias] ?? defaultAlias;
  }
  return config.models[aliasOrId] ?? aliasOrId;
}
