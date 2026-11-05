// POST /v1/chat/completions with "Authorization: Bearer <tenant key>".
// Applies the per tenant token limit and routes to primary/secondary provider.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { findTenant, openDb, upsertTenant } from "./db.ts";
import { SlidingWindowLimiter, estimateTokens } from "./rate-limiter.ts";
import { routeWithFallback, type Provider } from "./router.ts";
import { GatewayError, errorPayload, toGatewayError } from "./errors.ts";

const MAX_BODY_BYTES = 2_000_000;

const log = (msg: string, extra?: object) =>
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }) + "\n");

export interface RouterServerOptions {
  db: DatabaseSync;
  providers: Provider[];
  timeoutMs?: number;
  windowMs?: number;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    if ((size += c.length) > MAX_BODY_BYTES) throw new GatewayError("invalid_request_error", { publicMessage: "Request body too large." });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError("invalid_request_error", { publicMessage: "Request body must be valid JSON." });
  }
}

function validate(body: any) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages) || body.messages.length === 0) {
    throw new GatewayError("invalid_request_error", { publicMessage: "`messages` must be a non-empty array." });
  }
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) {
    throw new GatewayError("invalid_request_error", { publicMessage: "`max_tokens` must be a positive integer." });
  }
  // TODO: streaming support
  if (body.stream) {
    throw new GatewayError("invalid_request_error", { publicMessage: "Streaming is not supported on this endpoint." });
  }
}

export function createRouterServer(opts: RouterServerOptions): http.Server {
  const { db, providers, timeoutMs = 3000 } = opts;
  const limiter = new SlidingWindowLimiter(db, opts.windowMs);
  const logRequest = db.prepare(
    `INSERT INTO request_log (request_id, tenant, provider, status, error_type, tokens, latency_ms, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return http.createServer(async (req, res) => {
    const requestId = randomUUID();
    const t0 = performance.now();
    res.setHeader("x-request-id", requestId);

    let tenantId: string | null = null;
    let reservationId: number | null = null;
    const clientGone = new AbortController();
    res.on("close", () => { if (!res.writableFinished) clientGone.abort(); });

    try {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
        throw new GatewayError("invalid_request_error", { publicMessage: "Unknown endpoint." });
      }

      const key = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      const tenant = key ? findTenant(db, key) : undefined;
      if (!tenant) throw new GatewayError("authentication_error");
      tenantId = tenant.id;

      const body = await readJson(req);
      validate(body);

      const estimate = estimateTokens(body);
      const r = limiter.reserve(tenant.id, estimate, tenant.limit_);
      res.setHeader("x-ratelimit-limit-tokens", tenant.limit_);
      res.setHeader("x-ratelimit-remaining-tokens", r.remaining);
      if (!r.allowed) {
        if (r.tooLarge) throw new GatewayError("request_too_large", { detail: `estimate ${estimate} > limit ${tenant.limit_}` });
        throw new GatewayError("rate_limit_exceeded", { retryAfterMs: r.retryAfterMs, detail: `estimate ${estimate}` });
      }
      reservationId = r.reservationId;

      const result = await routeWithFallback(providers, body, { timeoutMs, signal: clientGone.signal });

      // replace our estimate with what the provider actually reported
      const actual = Number(result.body?.usage?.total_tokens);
      const charged = Number.isFinite(actual) && actual >= 0 ? actual : estimate;
      limiter.reconcile(reservationId, charged);

      res.setHeader("x-gateway-provider", result.provider);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result.body));

      const fellBack = result.attempts.length > 1 ? result.attempts.slice(0, -1).map((a) => `${a.provider}:${a.outcome}`).join(",") : null;
      logRequest.run(requestId, tenantId, result.provider, 200, null, charged, Math.round(performance.now() - t0), fellBack, Date.now());
      if (fellBack) log("failover", { requestId, fellBack, servedBy: result.provider });
    } catch (raw) {
      const err = toGatewayError(raw);
      // nobody served the request, so don't charge the tenant for it
      if (reservationId !== null) limiter.release(reservationId);

      if (err.type === "internal_error") log("internal_error", { requestId, detail: err.detail, stack: (raw as Error)?.stack });
      logRequest.run(requestId, tenantId, null, err.status, err.type, null, Math.round(performance.now() - t0), err.detail ?? null, Date.now());

      if (res.headersSent || clientGone.signal.aborted) return;
      if (err.retryAfterMs !== undefined) res.setHeader("retry-after", Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
      res.writeHead(err.status, { "content-type": "application/json" }).end(JSON.stringify(errorPayload(err, requestId)));
    }
  });
}

if (import.meta.main) {
  const db = openDb(process.env.DB_PATH ?? fileURLToPath(new URL("./data/gateway.db", import.meta.url)));
  upsertTenant(db, process.env.DEMO_TENANT_KEY ?? "tenant-demo-key", "demo", 50_000);

  const providers: Provider[] = [
    { name: "primary", url: process.env.PRIMARY_URL ?? "http://localhost:9101/v1/chat/completions", apiKey: process.env.PRIMARY_API_KEY },
    { name: "secondary", url: process.env.SECONDARY_URL ?? "http://localhost:9102/v1/chat/completions", apiKey: process.env.SECONDARY_API_KEY },
  ];
  const port = Number(process.env.PORT ?? 8082);
  createRouterServer({ db, providers }).listen(port, () => log("listening", { port, providers: providers.map((p) => p.name) }));
}
