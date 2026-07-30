import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "./fs.mjs";

const CONFIG_DIR_ENV = "SELFHOST_CONFIG_DIR";

export const DEFAULT_SELFHOST_CONFIG = {
  version: 1,
  baseUrl: "https://gateway.example.com/v1",
  apiKeyEnv: "CLIENT_KEY",
  defaultModelAlias: "glm",
  models: {
    glm: "GLM-5.2-FP8",
    kimi: "kimi-k3"
  },
  structuredOutputSupported: null
};

export function resolveConfigDir() {
  return process.env[CONFIG_DIR_ENV] || path.join(os.homedir(), ".claude", "selfhost");
}

export function resolveConfigFile() {
  return path.join(resolveConfigDir(), "config.json");
}

function defaultConfig() {
  return { ...DEFAULT_SELFHOST_CONFIG, models: { ...DEFAULT_SELFHOST_CONFIG.models } };
}

// The raw config.json contents, or {} when there is no readable file. Callers
// that persist need this rather than the merged view, so that defaults the user
// never chose don't get frozen into their file.
function readOnDiskConfig() {
  const configFile = resolveConfigFile();
  if (!fs.existsSync(configFile)) {
    return {};
  }
  try {
    const parsed = readJsonFile(configFile);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function loadSelfhostConfig() {
  const configFile = resolveConfigFile();
  if (!fs.existsSync(configFile)) {
    return defaultConfig();
  }

  try {
    const parsed = readJsonFile(configFile);
    // `models` is NOT merged with the defaults. Merging made built-in aliases
    // impossible to remove: deleting one from config.json just let the default
    // reappear, so a decommissioned model kept resolving to a dead id. When the
    // file declares `models` — including an empty object, meaning "no aliases"
    // — that declaration is the whole truth.
    const hasOwnModels =
      Object.prototype.hasOwnProperty.call(parsed, "models") &&
      parsed.models &&
      typeof parsed.models === "object";
    return {
      ...DEFAULT_SELFHOST_CONFIG,
      ...parsed,
      models: hasOwnModels ? { ...parsed.models } : { ...DEFAULT_SELFHOST_CONFIG.models }
    };
  } catch {
    return defaultConfig();
  }
}

export function saveSelfhostConfig(config) {
  fs.mkdirSync(resolveConfigDir(), { recursive: true });
  writeJsonFile(resolveConfigFile(), config);
  return config;
}

export function updateSelfhostConfig(mutate) {
  const onDisk = readOnDiskConfig();
  const merged = loadSelfhostConfig();
  const before = JSON.parse(JSON.stringify(merged));

  mutate(merged);

  // Persist a key only when the user already had it on disk or the mutation
  // actually changed it. Writing the whole merged view instead would stamp
  // every default into config.json on the first `setup` run, which is how the
  // hardcoded aliases became unremovable in practice.
  const next = { ...onDisk };
  for (const key of Object.keys(merged)) {
    const changed = JSON.stringify(merged[key]) !== JSON.stringify(before[key]);
    if (changed || Object.prototype.hasOwnProperty.call(onDisk, key)) {
      next[key] = merged[key];
    }
  }
  saveSelfhostConfig(next);

  // Callers use the return value as a complete config (baseUrl, apiKeyEnv, ...),
  // so hand back the merged view, not the trimmed thing written to disk.
  return merged;
}

export function resolveModelId(config, aliasOrId) {
  if (!aliasOrId) {
    const defaultAlias = config.defaultModelAlias;
    return config.models[defaultAlias] ?? defaultAlias;
  }
  return config.models[aliasOrId] ?? aliasOrId;
}
