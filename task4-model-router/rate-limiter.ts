// Sliding window rate limiter based on tokens, stored in sqlite.
//
// Every request we let through adds a row (tenant, ts, tokens). A new request
// is allowed if the tokens used in the last 60s + its estimate <= limit.
// Flow is: reserve() with an estimate before calling the model, then
// reconcile() with the real usage, or release() if the call failed.
import type { DatabaseSync } from "node:sqlite";

export type ReserveResult =
  | { allowed: true; reservationId: number; remaining: number }
  | { allowed: false; retryAfterMs: number; remaining: number; tooLarge: boolean };

export class SlidingWindowLimiter {
  private readonly db: DatabaseSync;
  private readonly windowMs: number;

  constructor(db: DatabaseSync, windowMs = 60_000) {
    this.db = db;
    this.windowMs = windowMs;
  }

  // BEGIN IMMEDIATE takes the write lock up front, so two requests (or two
  // processes using the same db file) can't both pass the check at once.
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  reserve(tenant: string, tokens: number, limit: number, now = Date.now()): ReserveResult {
    if (tokens > limit) return { allowed: false, retryAfterMs: 0, remaining: limit, tooLarge: true };

    return this.tx(() => {
      const windowStart = now - this.windowMs;
      // clean up rows that are out of the window
      this.db.prepare(`DELETE FROM token_usage WHERE tenant = ? AND ts <= ?`).run(tenant, windowStart);

      const { used } = this.db
        .prepare(`SELECT COALESCE(SUM(tokens), 0) AS used FROM token_usage WHERE tenant = ?`)
        .get(tenant) as { used: number };

      if (used + tokens <= limit) {
        const { lastInsertRowid } = this.db
          .prepare(`INSERT INTO token_usage (tenant, ts, tokens) VALUES (?, ?, ?)`)
          .run(tenant, now, tokens);
        return { allowed: true as const, reservationId: Number(lastInsertRowid), remaining: limit - used - tokens };
      }

      // Over the limit. Work out when enough old rows expire for this request to fit,
      // so we can send a proper Retry-After.
      const mustFree = used + tokens - limit;
      const rows = this.db
        .prepare(`SELECT ts, tokens FROM token_usage WHERE tenant = ? ORDER BY ts ASC`)
        .all(tenant) as Array<{ ts: number; tokens: number }>;
      let freed = 0;
      let retryAt = now + this.windowMs;
      for (const r of rows) {
        freed += r.tokens;
        if (freed >= mustFree) { retryAt = r.ts + this.windowMs; break; }
      }
      return { allowed: false as const, retryAfterMs: Math.max(0, retryAt - now), remaining: Math.max(0, limit - used), tooLarge: false };
    });
  }

  reconcile(reservationId: number, actualTokens: number) {
    this.db.prepare(`UPDATE token_usage SET tokens = ? WHERE id = ?`).run(Math.max(0, Math.round(actualTokens)), reservationId);
  }

  release(reservationId: number) {
    this.db.prepare(`DELETE FROM token_usage WHERE id = ?`).run(reservationId);
  }

  usage(tenant: string, now = Date.now()): number {
    return (this.db
      .prepare(`SELECT COALESCE(SUM(tokens), 0) AS used FROM token_usage WHERE tenant = ? AND ts > ?`)
      .get(tenant, now - this.windowMs) as { used: number }).used;
  }
}

// rough estimate: ~4 chars per token for the prompt, plus max_tokens for the answer
export function estimateTokens(body: { messages?: Array<{ content?: unknown }>; max_tokens?: number }): number {
  let chars = 0;
  for (const m of body.messages ?? []) {
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }
  return Math.ceil(chars / 4) + (body.max_tokens ?? 1024);
}
