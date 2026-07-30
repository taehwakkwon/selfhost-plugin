import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverGatewayModels,
  findUnknownAliases,
  isPlaceholderBaseUrl,
  PLACEHOLDER_BASE_URL_HOST
} from "./model-discovery.mjs";

const REAL_CONFIG = {
  baseUrl: "https://gateway.internal.test/v1",
  apiKeyEnv: "TEST_GATEWAY_KEY",
  models: { glm: "GLM-5.2-FP8" }
};

const ENV = { TEST_GATEWAY_KEY: "token-value" };

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("isPlaceholderBaseUrl recognizes the shipped default", () => {
  assert.equal(isPlaceholderBaseUrl(`https://${PLACEHOLDER_BASE_URL_HOST}/v1`), true);
  assert.equal(isPlaceholderBaseUrl("https://gateway.internal.test/v1"), false);
  assert.equal(isPlaceholderBaseUrl(null), false);
});

test("discovery returns the sorted model ids from an OpenAI-shaped list", async () => {
  let requestedUrl = null;
  let sentAuth = null;
  const result = await discoverGatewayModels(REAL_CONFIG, {
    env: ENV,
    fetch: async (url, init) => {
      requestedUrl = url;
      sentAuth = init.headers.Authorization;
      return jsonResponse({
        object: "list",
        data: [{ id: "kimi-k3" }, { id: "GLM-5.2-FP8" }, { id: "poolside/Laguna-S-2.1" }]
      });
    }
  });

  assert.equal(requestedUrl, "https://gateway.internal.test/v1/models");
  assert.equal(sentAuth, "Bearer token-value");
  assert.equal(result.available, true);
  assert.deepEqual(result.models, ["GLM-5.2-FP8", "kimi-k3", "poolside/Laguna-S-2.1"]);
});

test("discovery is skipped for the placeholder base URL and never calls fetch", async () => {
  let called = false;
  const result = await discoverGatewayModels(
    { ...REAL_CONFIG, baseUrl: `https://${PLACEHOLDER_BASE_URL_HOST}/v1` },
    {
      env: ENV,
      fetch: async () => {
        called = true;
        return jsonResponse({ data: [] });
      }
    }
  );

  assert.equal(called, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, "placeholder");
  assert.match(result.detail, /placeholder/);
});

test("discovery reports a missing api key without throwing", async () => {
  const result = await discoverGatewayModels(REAL_CONFIG, {
    env: {},
    fetch: async () => jsonResponse({ data: [] })
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "no-token");
  assert.match(result.detail, /TEST_GATEWAY_KEY/);
});

test("a non-OK response degrades gracefully", async () => {
  const result = await discoverGatewayModels(REAL_CONFIG, {
    env: ENV,
    fetch: async () => jsonResponse({}, { ok: false, status: 503 })
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "http");
  assert.match(result.detail, /503/);
  assert.deepEqual(result.models, []);
});

test("a malformed body degrades gracefully", async () => {
  const result = await discoverGatewayModels(REAL_CONFIG, {
    env: ENV,
    fetch: async () => jsonResponse({ models: ["not", "the", "right", "shape"] })
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "malformed");
});

test("a thrown network error degrades gracefully instead of propagating", async () => {
  const result = await discoverGatewayModels(REAL_CONFIG, {
    env: ENV,
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND gateway.internal.test");
    }
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "error");
  assert.match(result.detail, /ENOTFOUND/);
});

test("entries without a usable id are dropped", async () => {
  const result = await discoverGatewayModels(REAL_CONFIG, {
    env: ENV,
    fetch: async () => jsonResponse({ data: [{ id: "good" }, {}, { id: "" }, { id: 42 }] })
  });
  assert.deepEqual(result.models, ["good"]);
});

test("findUnknownAliases flags only aliases the gateway does not serve", () => {
  const unknown = findUnknownAliases(
    { glm: "GLM-5.2-FP8", dead: "deepseek-ai/DeepSeek-V4-Flash" },
    ["GLM-5.2-FP8", "kimi-k3"]
  );
  assert.deepEqual(unknown, [{ alias: "dead", modelId: "deepseek-ai/DeepSeek-V4-Flash" }]);
});

test("findUnknownAliases tolerates an absent models map", () => {
  assert.deepEqual(findUnknownAliases(undefined, ["GLM-5.2-FP8"]), []);
});
