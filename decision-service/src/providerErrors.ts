export type ProviderFailure = {
  statusCode: number;
  detail: string;
};

type ErrorLike = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  response?: { status?: unknown } | null;
};

function finiteStatus(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 400 && parsed <= 599 ? parsed : null;
}

/**
 * Converts provider/SDK failures into safe, actionable HTTP errors.
 * Raw SDK messages are intentionally not returned because they may include
 * request metadata, provider details, or other sensitive information.
 */
export function classifyProviderError(error: unknown): ProviderFailure {
  const value = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const status = finiteStatus(value.status)
    ?? finiteStatus(value.statusCode)
    ?? finiteStatus(value.response?.status);
  const name = typeof value.name === "string" ? value.name : "";
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  const signature = `${name} ${code} ${message}`.toLowerCase();

  if (status === 401) {
    return { statusCode: 401, detail: "Provider authentication failed. Check that the request-scoped API key is valid." };
  }
  if (status === 403) {
    return { statusCode: 403, detail: "The provider account or API key does not have access to the selected Jev model." };
  }
  if (status === 404) {
    return { statusCode: 422, detail: "The selected Jev model or provider endpoint was not found. Check model availability and provider access." };
  }
  if (status === 402) {
    return { statusCode: 402, detail: "The provider reports a quota or billing restriction. Check the provider account's usage limits." };
  }
  if (status === 429) {
    return { statusCode: 429, detail: "The provider rate limit was reached. Wait briefly before trying again." };
  }
  if (status === 408 || /timeout|timed out|aborterror|timeouterror/.test(signature)) {
    return { statusCode: 504, detail: "The provider evaluation timed out. Retry or continue with the static balanced route." };
  }
  if (status !== null && status >= 500) {
    return { statusCode: 503, detail: "The AI provider is temporarily unavailable. Retry or continue with the static balanced route." };
  }
  if (status !== null && status >= 400) {
    return { statusCode: 422, detail: "The provider rejected the evaluation request. Check the key, model access, and request configuration." };
  }
  if (/apiconnectionerror|network|fetch failed|econn|enotfound|und_err/.test(signature)) {
    return { statusCode: 503, detail: "The AI provider could not be reached. Check connectivity and retry." };
  }

  return {
    statusCode: 502,
    detail: "JEV could not produce a valid decision. No adaptive weights were applied; the static balanced route remains available.",
  };
}
