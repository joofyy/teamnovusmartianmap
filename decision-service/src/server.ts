import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  evaluateNasaEvidence,
  evaluatePathfindingWeights,
  type JevProvider,
  type NasaEvidenceInput,
} from "./jevDecision.js";
import { classifyProviderError } from "./providerErrors.js";

export type ServerOptions = {
  serviceToken?: string;
  requestTimeoutMs?: number;
  rateLimitPerWindow?: number;
  rateWindowMs?: number;
};

// Correlation ids span the FastAPI -> JEV -> provider chain. FastAPI sends
// X-Correlation-Id; if absent we generate one. The id is echoed on every
// response (including errors) but never carries credentials or payloads.
function getCorrelationId(req: Request): string {
  const existing = req.header("x-correlation-id");
  if (existing && /^[A-Za-z0-9_-]{1,128}$/.test(existing)) return existing;
  return randomUUID();
}

function sendJevError(req: Request, res: Response, status: number, detail: string): void {
  const cid = (req as unknown as { correlationId?: string }).correlationId ?? null;
  res.status(status).json({ detail, correlationId: cid });
}

function timingSafeTokenMatch(candidate: string, expected: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("JEV request timed out.")), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createApp(options?: ServerOptions) {
  const app = express();
  const serviceToken =
    options?.serviceToken !== undefined
      ? options.serviceToken.trim()
      : (process.env.MARSCOPE_JEV_SERVICE_TOKEN?.trim() ?? "");
  const requestTimeoutMs =
    options?.requestTimeoutMs ??
    Math.min(120_000, Math.max(15_000, Number(process.env.JEV_REQUEST_TIMEOUT_MS ?? 95_000)));
  const rateWindowMs = options?.rateWindowMs ?? 60_000;
  const rateLimitPerWindow = options?.rateLimitPerWindow ?? 20;
  const requestCounts = new Map<string, { count: number; startedAt: number }>();

  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.use((req, res, next) => {
    const cid = getCorrelationId(req);
    res.setHeader("X-Correlation-Id", cid);
    (req as unknown as { correlationId: string }).correlationId = cid;
    next();
  });

  function requireServiceToken(req: Request, res: Response, next: NextFunction): void {
    if (!serviceToken) {
      sendJevError(req, res, 503, "JEV service authentication is not configured.");
      return;
    }
    const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
    const candidate = match?.[1] ?? "";
    if (!candidate || !timingSafeTokenMatch(candidate, serviceToken)) {
      sendJevError(req, res, 401, "Unauthorized JEV service request.");
      return;
    }
    next();
  }

  function limitRequests(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = req.ip || "unknown";
    const current = requestCounts.get(key);
    if (!current || now - current.startedAt >= rateWindowMs) {
      requestCounts.set(key, { count: 1, startedAt: now });
      next();
      return;
    }
    current.count += 1;
    if (current.count > rateLimitPerWindow) {
      sendJevError(req, res, 429, "JEV request limit reached. Try again shortly.");
      return;
    }
    next();
  }

  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      service: "marscope-jev-decision-service",
      configured: Boolean(serviceToken),
      correlationId: (req as unknown as { correlationId?: string }).correlationId ?? null,
    });
  });

  app.use("/v1", requireServiceToken);
  app.use("/v1", express.json({ limit: "32kb", strict: true }));

  app.post("/v1/pathfinding-weights", limitRequests, async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      sendJevError(req, res, 400, "A JSON request body is required.");
      return;
    }
    const { provider, apiKey, missionPrompt, availableLayers, missionContext } = body;
    if (provider !== "typesafe" && provider !== "opencode") {
      sendJevError(req, res, 400, "Select a supported JEV provider.");
      return;
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0 || apiKey.length > 1024) {
      sendJevError(req, res, 400, "Enter a valid provider API key (maximum 1,024 characters).");
      return;
    }
    if (typeof missionPrompt !== "string" || missionPrompt.trim().length < 1 || missionPrompt.length > 600) {
      sendJevError(req, res, 400, "Mission prompt must contain 1–600 characters.");
      return;
    }
    if (!Array.isArray(availableLayers) || availableLayers.length > 32 ||
        availableLayers.some((value) => typeof value !== "string" || value.length > 64)) {
      sendJevError(req, res, 400, "Available terrain layers are invalid.");
      return;
    }
    if (missionContext !== undefined &&
        (missionContext === null || typeof missionContext !== "object" || Array.isArray(missionContext))) {
      sendJevError(req, res, 400, "Mission context must be a simple object.");
      return;
    }

    try {
      const result = await withTimeout(
        evaluatePathfindingWeights({
          apiKey,
          provider: provider as JevProvider,
          missionPrompt,
          availableLayers: availableLayers as string[],
          missionContext: missionContext as Record<string, string | number | boolean | null> | undefined,
        }),
        requestTimeoutMs,
      );
      res.status(200).json(result);
    } catch (error) {
      // Return a safe status-specific message; never expose raw SDK/provider errors.
      const failure = classifyProviderError(error);
      sendJevError(req, res, failure.statusCode, failure.detail);
    }
  });

  app.post("/v1/evidence-assessment", limitRequests, async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      sendJevError(req, res, 400, "A JSON request body is required.");
      return;
    }
    const { provider, apiKey, objective, hypothesis, evidence } = body;
    if (provider !== "typesafe" && provider !== "opencode") {
      sendJevError(req, res, 400, "Select a supported JEV provider.");
      return;
    }
    if (typeof apiKey !== "string" || apiKey.trim().length === 0 || apiKey.length > 1024) {
      sendJevError(req, res, 400, "Enter a valid provider API key (maximum 1,024 characters).");
      return;
    }
    if (typeof objective !== "string" || !objective.trim() || objective.length > 500) {
      sendJevError(req, res, 400, "Mission objective must contain 1–500 characters.");
      return;
    }
    if (typeof hypothesis !== "string" || !hypothesis.trim() || hypothesis.length > 700) {
      sendJevError(req, res, 400, "Hypothesis must contain 1–700 characters.");
      return;
    }
    if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 4) {
      sendJevError(req, res, 400, "Provide between 1 and 4 NASA evidence records.");
      return;
    }
    for (const record of evidence) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        sendJevError(req, res, 400, "Each NASA evidence record must be an object.");
        return;
      }
      const item = record as Record<string, unknown>;
      if (["id", "title", "summary", "url"].some((key) => typeof item[key] !== "string" || !(item[key] as string).trim() || (item[key] as string).length > 2_000)) {
        sendJevError(req, res, 400, "Evidence records need an ID, title, summary and source URL.");
        return;
      }
    }

    try {
      const result = await withTimeout(
        evaluateNasaEvidence({ apiKey, provider: provider as JevProvider, objective, hypothesis, evidence: evidence as NasaEvidenceInput[] }),
        requestTimeoutMs,
      );
      res.status(200).json(result);
    } catch (error) {
      // Evidence review uses the same safe provider error mapping as pathfinding.
      const failure = classifyProviderError(error);
      sendJevError(req, res, failure.statusCode, failure.detail);
    }
  });

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const errorType = (error as { type?: string } | null)?.type;
    const isBodyError = error instanceof SyntaxError || errorType === "entity.too.large";
    sendJevError(req, res, isBodyError ? 400 : 500, isBodyError ? "Invalid or oversized JSON request." : "JEV service request failed.");
  });

  return app;
}

export const app = createApp();

const isDirectRun =
  process.env.NODE_ENV !== "test" &&
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts"));

if (isDirectRun) {
  const port = Number(process.env.PORT ?? process.env.MARSCOPE_JEV_PORT ?? 8100);
  const host = process.env.HOST ?? "0.0.0.0";
  app.listen(port, host, () => {
    console.log("MARSCOPE JEV decision service listening on " + host + ":" + port);
  });
}
