import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp } from "./server.js";

async function withServer(
  options: { serviceToken?: string },
  fn: (baseUrl: string) => Promise<void>,
) {
  const app = createApp(options);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Invalid server address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("health endpoint returns 200, configured=true, correlation id, and security headers", async () => {
  await withServer({ serviceToken: "test-token-123" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store, max-age=0");
    assert.equal(res.headers.get("pragma"), "no-cache");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const cid = res.headers.get("x-correlation-id");
    assert.ok(cid && cid.length > 0);

    const body = await res.json() as { status: string; service: string; configured: boolean; correlationId: string };
    assert.equal(body.status, "ok");
    assert.equal(body.service, "marscope-jev-decision-service");
    assert.equal(body.configured, true);
    assert.equal(body.correlationId, cid);
  });
});

test("health endpoint reports configured=false when service token is empty", async () => {
  await withServer({ serviceToken: "" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json() as { configured: boolean };
    assert.equal(body.configured, false);
  });
});

test("echoes supplied valid X-Correlation-Id across responses", async () => {
  await withServer({ serviceToken: "test-token" }, async (baseUrl) => {
    const clientCid = "mars-req-998877";
    const res = await fetch(`${baseUrl}/health`, {
      headers: { "x-correlation-id": clientCid },
    });
    assert.equal(res.headers.get("x-correlation-id"), clientCid);
    const body = await res.json() as { correlationId: string };
    assert.equal(body.correlationId, clientCid);
  });
});

test("returns 503 when service authentication is not configured", async () => {
  await withServer({ serviceToken: "" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer some-token",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 503);
    const body = await res.json() as { detail: string; correlationId: string };
    assert.match(body.detail, /JEV service authentication is not configured/i);
    assert.ok(body.correlationId);
  });
});

test("returns 401 when Authorization header is missing or incorrect", async () => {
  await withServer({ serviceToken: "secret-token-xyz" }, async (baseUrl) => {
    // Missing auth header
    const res1 = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res1.status, 401);
    const body1 = await res1.json() as { detail: string };
    assert.match(body1.detail, /Unauthorized JEV service request/i);
    assert.doesNotMatch(JSON.stringify(body1), /secret-token-xyz/);

    // Incorrect bearer token
    const res2 = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong-token-abc",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res2.status, 401);
    const body2 = await res2.json() as { detail: string };
    assert.match(body2.detail, /Unauthorized JEV service request/i);
    assert.doesNotMatch(JSON.stringify(body2), /wrong-token-abc|secret-token-xyz/);
  });
});

test("returns 400 on invalid JSON syntax", async () => {
  await withServer({ serviceToken: "secret-token-xyz" }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token-xyz",
      },
      body: "{ broken json syntax ...",
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { detail: string; correlationId: string };
    assert.match(body.detail, /Invalid or oversized JSON request/i);
    assert.ok(body.correlationId);
  });
});

test("returns 400 on oversized JSON payload exceeding 32kb limit", async () => {
  await withServer({ serviceToken: "secret-token-xyz" }, async (baseUrl) => {
    const hugePadding = "x".repeat(35 * 1024);
    const res = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token-xyz",
      },
      body: JSON.stringify({ padding: hugePadding }),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { detail: string };
    assert.match(body.detail, /Invalid or oversized JSON request/i);
  });
});

test("returns 400 validation error on missing or invalid payload fields", async () => {
  await withServer({ serviceToken: "secret-token-xyz" }, async (baseUrl) => {
    // Missing required provider
    const res1 = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token-xyz",
      },
      body: JSON.stringify({
        provider: "unsupported-provider",
        apiKey: "some-key",
        missionPrompt: "Explore Jezero crater safely",
        availableLayers: ["elevation"],
      }),
    });
    assert.equal(res1.status, 400);
    const body1 = await res1.json() as { detail: string };
    assert.match(body1.detail, /Select a supported JEV provider/i);

    // Missing API key
    const res2 = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token-xyz",
      },
      body: JSON.stringify({
        provider: "typesafe",
        apiKey: "   ",
        missionPrompt: "Explore Jezero crater safely",
        availableLayers: ["elevation"],
      }),
    });
    assert.equal(res2.status, 400);
    const body2 = await res2.json() as { detail: string };
    assert.match(body2.detail, /valid provider API key/i);
  });
});

test("no credential leakage in headers or error bodies", async () => {
  const secretKey = "super-secret-user-provider-key-9999";
  const serviceToken = "internal-service-token-8888";
  await withServer({ serviceToken }, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/v1/pathfinding-weights`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        provider: "typesafe",
        apiKey: secretKey,
        missionPrompt: "", // Invalid empty prompt to trigger 400
        availableLayers: ["elevation"],
      }),
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.doesNotMatch(text, new RegExp(secretKey));
    assert.doesNotMatch(text, new RegExp(serviceToken));
    for (const [key, val] of res.headers.entries()) {
      assert.doesNotMatch(key, new RegExp(secretKey));
      assert.doesNotMatch(val, new RegExp(secretKey));
      assert.doesNotMatch(key, new RegExp(serviceToken));
      assert.doesNotMatch(val, new RegExp(serviceToken));
    }
  });
});
