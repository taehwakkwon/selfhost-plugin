export const PROVIDER_ID = "sgl-gateway";

const PERMISSION_PROFILES = {
  rescue: { edit: "allow", bash: "allow" },
  review: { edit: "deny", bash: "deny" }
};

export function buildOpencodeConfig(sglConfig, permissionProfile) {
  if (!sglConfig.baseUrl) {
    throw new Error("No gateway base URL configured. Run /sgl:setup --base-url <url> first.");
  }

  const permission = PERMISSION_PROFILES[permissionProfile];
  if (!permission) {
    throw new Error(`Unknown permission profile "${permissionProfile}". Use "rescue" or "review".`);
  }

  const models = {};
  for (const modelId of new Set(Object.values(sglConfig.models ?? {}))) {
    models[modelId] = { name: modelId };
  }

  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "sgl gateway",
        options: {
          baseURL: sglConfig.baseUrl,
          apiKey: `{env:${sglConfig.apiKeyEnv}}`
        },
        models
      }
    },
    permission
  };
}
