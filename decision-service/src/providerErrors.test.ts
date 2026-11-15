import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError } from "./providerErrors.js";

test("invalid provider key remains a clear authentication error", () => {
  const failure = classifyProviderError({ status: 401, message: "private provider response" });
  assert.equal(failure.statusCode, 401);
  assert.match(failure.detail, /authentication failed/i);
  assert.equal(failure.detail.includes("private provider response"), false);
});

test("provider access errors are not presented as service outages", () => {
  const failure = classifyProviderError({ statusCode: 403 });
  assert.equal(failure.statusCode, 403);
  assert.match(failure.detail, /does not have access/i);
});

test("provider model-not-found errors explain model availability", () => {
  const failure = classifyProviderError({ status: 404 });
  assert.equal(failure.statusCode, 422);
  assert.match(failure.detail, /model.*not found|not found.*model/i);
});

test("provider rate limits remain 429 and are not rewritten as generic 502", () => {
  const failure = classifyProviderError({ status: 429 });
  assert.equal(failure.statusCode, 429);
  assert.match(failure.detail, /rate limit/i);
});

test("provider server errors map to retryable service unavailable", () => {
  const failure = classifyProviderError({ status: 529 });
  assert.equal(failure.statusCode, 503);
  assert.match(failure.detail, /temporarily unavailable/i);
});

test("provider timeouts map to gateway timeout", () => {
  const failure = classifyProviderError(new Error("JEV request timed out."));
  assert.equal(failure.statusCode, 504);
});

test("network failures map to service unavailable", () => {
  const failure = classifyProviderError({ name: "APIConnectionError", code: "ECONNRESET" });
  assert.equal(failure.statusCode, 503);
});

test("unknown failures use a safe generic message", () => {
  const failure = classifyProviderError(new Error("secret-bearing raw provider detail"));
  assert.equal(failure.statusCode, 502);
  assert.equal(failure.detail.includes("secret-bearing"), false);
});
