import process from "node:process";

// The default baseUrl is deliberately not a working endpoint. Discovery has to
// recognize it so `setup` can say "configure a gateway first" instead of
// reporting a DNS failure as if something were broken.
export const PLACEHOLDER_BASE_URL_HOST = "gateway.example.com";

export const DISCOVERY_TIMEOUT_MS = 15000;

export function isPlaceholderBaseUrl(baseUrl) {
  return typeof baseUrl === "string" && baseUrl.includes(PLACEHOLDER_BASE_URL_HOST);
}

/**
 * List the models the gateway actually serves.
 *
 * Only `setup` calls this. Model resolution at rescue/review time stays
 * synchronous and offline (see resolveModelId) — putting a network round trip
 * in front of every job would add a failure mode and latency to answer a
 * question whose answer does not change between jobs.
 *
 * Never throws: a gateway that is down must not make `setup` fail, because
 * setup is how you diagnose a gateway that is down.
 */
export async function discoverGatewayModels(selfhostConfig, options = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const env = options.env ?? process.env;

  if (isPlaceholderBaseUrl(selfhostConfig.baseUrl)) {
    return {
      available: false,
      reason: "placeholder",
      models: [],
      detail: `No gateway configured yet — baseUrl is still the ${PLACEHOLDER_BASE_URL_HOST} placeholder.`
    };
  }

  const token = env[selfhostConfig.apiKeyEnv];
  if (!token) {
    return {
      available: false,
      reason: "no-token",
      models: [],
      detail: `Environment variable ${selfhostConfig.apiKeyEnv} is not set.`
    };
  }

  try {
    const response = await fetchImpl(`${selfhostConfig.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return {
        available: false,
        reason: "http",
        models: [],
        detail: `Gateway responded with HTTP ${response.status} when listing models.`
      };
    }

    const body = await response.json();
    if (!Array.isArray(body?.data)) {
      return {
        available: false,
        reason: "malformed",
        models: [],
        detail: "Gateway returned a model list in an unexpected shape (no `data` array)."
      };
    }

    const models = body.data
      .map((entry) => entry?.id)
      .filter((id) => typeof id === "string" && id.length > 0)
      .sort();
    return {
      available: true,
      reason: null,
      models,
      detail: `${models.length} model(s) available at ${selfhostConfig.baseUrl}.`
    };
  } catch (error) {
    return {
      available: false,
      reason: "error",
      models: [],
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Aliases whose target is missing from the gateway's list. Reported, never
 * auto-removed: a gateway can omit a model for reasons that have nothing to do
 * with the user's config, and silently deleting their aliases would be worse
 * than a stale one.
 */
export function findUnknownAliases(configuredModels, discoveredModelIds) {
  const known = new Set(discoveredModelIds);
  return Object.entries(configuredModels ?? {})
    .filter(([, modelId]) => !known.has(modelId))
    .map(([alias, modelId]) => ({ alias, modelId }));
}
