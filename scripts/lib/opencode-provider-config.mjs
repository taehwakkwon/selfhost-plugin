export const PROVIDER_ID = "selfhost-gateway";

const PERMISSION_PROFILES = {
  rescue: { edit: "allow", bash: "allow" },
  review: { edit: "deny", bash: "deny" }
};

export function buildOpencodeConfig(selfhostConfig, permissionProfile) {
  if (!selfhostConfig.baseUrl) {
    throw new Error("No gateway base URL configured. Run /selfhost:setup --base-url <url> first.");
  }

  const permission = PERMISSION_PROFILES[permissionProfile];
  if (!permission) {
    throw new Error(`Unknown permission profile "${permissionProfile}". Use "rescue" or "review".`);
  }

  const models = {};
  for (const modelId of new Set(Object.values(selfhostConfig.models ?? {}))) {
    models[modelId] = { name: modelId };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "selfhost gateway",
        options: {
          baseURL: selfhostConfig.baseUrl,
          apiKey: `{env:${selfhostConfig.apiKeyEnv}}`
        },
        models
      }
    },
    permission
  };
}
