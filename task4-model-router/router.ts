// Tries providers in order and falls back to the next one on 429, timeout,
// 5xx or network error. Other 4xx means the request is bad, so there's no
// point trying another provider.
import { GatewayError } from "./errors.ts";

export interface Provider {
  name: string;
  url: string;
  apiKey?: string;
  model?: string; // if set, replaces body.model for this provider
}

export interface Attempt {
  provider: string;
  outcome: "ok" | "rate_limited" | "timeout" | "server_error" | "network_error" | "client_error";
  status?: number;
  ms: number;
  detail?: string;
}

export interface RouteResult {
  provider: string;
  body: any;
  attempts: Attempt[];
}

type AttemptOutcome =
  | { ok: true; body: any; status: number }
  | { ok: false; outcome: Exclude<Attempt["outcome"], "ok">; status?: number; detail: string; failover: boolean };

async function attempt(p: Provider, body: object, timeoutMs: number, clientSignal?: AbortSignal): Promise<AttemptOutcome> {
  // Each attempt has its own controller. On timeout we abort the fetch, so a
  // slow primary can't come back later and get used after we've moved on.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeoutMs);
  const signal = clientSignal ? AbortSignal.any([ctrl.signal, clientSignal]) : ctrl.signal;

  try {
    const res = await fetch(p.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
      body: JSON.stringify(p.model ? { ...body, model: p.model } : body),
      signal,
    });
    // read the body before clearing the timer, otherwise a provider that sends
    // headers and then hangs would never time out
    const text = await res.text();

    if (res.ok) {
      try {
        return { ok: true, status: res.status, body: JSON.parse(text) };
      } catch {
        return { ok: false, outcome: "server_error", status: res.status, detail: "invalid JSON from provider", failover: true };
      }
    }
    const detail = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 429) return { ok: false, outcome: "rate_limited", status: 429, detail, failover: true };
    if (res.status >= 500) return { ok: false, outcome: "server_error", status: res.status, detail, failover: true };
    return { ok: false, outcome: "client_error", status: res.status, detail, failover: false };
  } catch (err: any) {
    if (clientSignal?.aborted) throw new GatewayError("internal_error", { detail: "client disconnected" });
    if (ctrl.signal.aborted) return { ok: false, outcome: "timeout", detail: `no complete response within ${timeoutMs}ms`, failover: true };
    return { ok: false, outcome: "network_error", detail: String(err?.cause ?? err), failover: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function routeWithFallback(
  providers: Provider[],
  body: object,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RouteResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const attempts: Attempt[] = [];

  for (const p of providers) {
    const t0 = performance.now();
    const r = await attempt(p, body, timeoutMs, opts.signal);
    const ms = Math.round(performance.now() - t0);

    if (r.ok) {
      attempts.push({ provider: p.name, outcome: "ok", status: r.status, ms });
      return { provider: p.name, body: r.body, attempts };
    }
    attempts.push({ provider: p.name, outcome: r.outcome, status: r.status, ms, detail: r.detail });
    if (!r.failover) {
      throw Object.assign(
        new GatewayError("invalid_request_error", { publicMessage: "The model provider rejected the request.", detail: r.detail }),
        { attempts },
      );
    }
  }

  // all failed, only call it a timeout if every attempt timed out
  const allTimedOut = attempts.every((a) => a.outcome === "timeout");
  throw Object.assign(
    new GatewayError(allTimedOut ? "upstream_timeout" : "upstream_unavailable", {
      detail: attempts.map((a) => `${a.provider}:${a.outcome}${a.status ? `(${a.status})` : ""}`).join(", "),
    }),
    { attempts },
  );
}
