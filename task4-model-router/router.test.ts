import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { openDb, upsertTenant } from "./db.ts";
import { SlidingWindowLimiter, estimateTokens } from "./rate-limiter.ts";
import { routeWithFallback } from "./router.ts";
import { createRouterServer } from "./server.ts";
import { createMockProvider } from "./mock-providers.ts";

const dir = mkdtempSync(join(tmpdir(), "router-test-"));
const opened: DatabaseSync[] = [];
const track = (db: DatabaseSync) => (opened.push(db), db);
const freshDb = () => track(openDb(join(dir, `t${opened.length}.db`))); // real on-disk SQLite files

after(() => {
  for (const db of opened) db.close(); // Windows can't delete open files
  rmSync(dir, { recursive: true, force: true });
});

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));

describe("SlidingWindowLimiter", () => {
  test("admits up to the limit, then denies", () => {
    const l = new SlidingWindowLimiter(freshDb());
    const t = 1_000_000;
    assert.equal(l.reserve("a", 30_000, 50_000, t).allowed, true);
    assert.equal(l.reserve("a", 20_000, 50_000, t + 1).allowed, true);
    const denied = l.reserve("a", 1, 50_000, t + 2);
    assert.equal(denied.allowed, false);
  });

  test("window slides: old usage is evicted and retry-after is exact", () => {
    const l = new SlidingWindowLimiter(freshDb());
    const t = 1_000_000;
    l.reserve("a", 30_000, 50_000, t);
    l.reserve("a", 20_000, 50_000, t + 10_000);
    const d = l.reserve("a", 25_000, 50_000, t + 20_000);
    assert.equal(d.allowed, false);
    // 30k entry at t expires at t+60s, so 40s from now
    assert.equal(!d.allowed && d.retryAfterMs, 40_000);
    assert.equal(l.reserve("a", 25_000, 50_000, t + 59_999).allowed, false);
    assert.equal(l.reserve("a", 25_000, 50_000, t + 60_000).allowed, true);
  });

  test("tenants are isolated", () => {
    const l = new SlidingWindowLimiter(freshDb());
    l.reserve("a", 50_000, 50_000, 0);
    assert.equal(l.reserve("b", 50_000, 50_000, 0).allowed, true);
  });

  test("reconcile replaces estimate with actual; release refunds", () => {
    const l = new SlidingWindowLimiter(freshDb());
    const r = l.reserve("a", 40_000, 50_000, 0);
    assert.ok(r.allowed);
    l.reconcile(r.reservationId, 500);
    assert.equal(l.usage("a", 1), 500);
    l.release(r.reservationId);
    assert.equal(l.usage("a", 1), 0);
  });

  test("single request larger than the limit is flagged tooLarge", () => {
    const r = new SlidingWindowLimiter(freshDb()).reserve("a", 60_000, 50_000);
    assert.ok(!r.allowed && r.tooLarge);
  });

  test("two connections to the same DB file never over-admit", () => {
    const path = join(dir, "shared.db");
    const l1 = new SlidingWindowLimiter(track(openDb(path)));
    const l2 = new SlidingWindowLimiter(track(openDb(path)));
    let admitted = 0;
    for (let i = 0; i < 20; i++) if ((i % 2 ? l1 : l2).reserve("a", 5_000, 50_000, 0).allowed) admitted++;
    assert.equal(admitted, 10);
  });

  test("estimateTokens = prompt chars/4 + max_tokens", () => {
    assert.equal(estimateTokens({ messages: [{ content: "abcdefgh" }], max_tokens: 100 }), 102);
  });
});

describe("routeWithFallback", () => {
  const providers: Record<string, ReturnType<typeof createMockProvider>> = {};
  const urls: Record<string, string> = {};

  before(async () => {
    for (const [name, mode] of [["ok1", "ok"], ["ok2", "ok"], ["rl", "429"], ["slow", "slow"], ["err", "500"], ["stall", "stall"]] as const) {
      providers[name] = createMockProvider(name, mode, { slowMs: 2000 });
      urls[name] = `http://127.0.0.1:${await listen(providers[name].server)}/v1/chat/completions`;
    }
  });
  after(() => Object.values(providers).forEach((p) => { p.server.closeAllConnections(); p.server.close(); }));

  const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const P = (name: string) => ({ name, url: urls[name] });

  test("primary OK -> secondary never called", async () => {
    const before = providers.ok2.state.calls;
    const r = await routeWithFallback([P("ok1"), P("ok2")], body);
    assert.equal(r.provider, "ok1");
    assert.equal(providers.ok2.state.calls, before);
  });

  test("primary 429 -> secondary", async () => {
    const r = await routeWithFallback([P("rl"), P("ok2")], body);
    assert.equal(r.provider, "ok2");
    assert.equal(r.attempts[0].outcome, "rate_limited");
  });

  test("primary timeout -> secondary, within timeout + small overhead", async () => {
    const t0 = performance.now();
    const r = await routeWithFallback([P("slow"), P("ok2")], body, { timeoutMs: 300 });
    const ms = performance.now() - t0;
    assert.equal(r.provider, "ok2");
    assert.equal(r.attempts[0].outcome, "timeout");
    assert.ok(ms < 800, `took ${ms}ms`);
  });

  test("headers-then-stall counts as timeout", async () => {
    const r = await routeWithFallback([P("stall"), P("ok2")], body, { timeoutMs: 300 });
    assert.equal(r.attempts[0].outcome, "timeout");
    assert.equal(r.provider, "ok2");
  });

  test("primary 5xx -> secondary", async () => {
    const r = await routeWithFallback([P("err"), P("ok2")], body);
    assert.equal(r.provider, "ok2");
  });

  test("all providers time out -> upstream_timeout", async () => {
    await assert.rejects(routeWithFallback([P("slow"), P("stall")], body, { timeoutMs: 200 }), { type: "upstream_timeout" });
  });

  test("mixed failures -> upstream_unavailable", async () => {
    await assert.rejects(routeWithFallback([P("rl"), P("err")], body), { type: "upstream_unavailable" });
  });
});

describe("gateway server", () => {
  let db: DatabaseSync;
  let primary: ReturnType<typeof createMockProvider>;
  let secondary: ReturnType<typeof createMockProvider>;
  let gw: http.Server;
  let url: string;

  before(async () => {
    db = freshDb();
    upsertTenant(db, "key-small", "small", 50_000);
    upsertTenant(db, "key-big", "big", 10_000_000);
    primary = createMockProvider("primary", "ok", { slowMs: 2000, latencyMs: 100 });
    secondary = createMockProvider("secondary", "ok");
    const pu = `http://127.0.0.1:${await listen(primary.server)}/v1/chat/completions`;
    const su = `http://127.0.0.1:${await listen(secondary.server)}/v1/chat/completions`;
    gw = createRouterServer({ db, providers: [{ name: "primary", url: pu }, { name: "secondary", url: su }], timeoutMs: 300 });
    url = `http://127.0.0.1:${await listen(gw)}/v1/chat/completions`;
  });
  after(() => { gw.close(); primary.server.closeAllConnections(); primary.server.close(); secondary.server.close(); });
  beforeEach(() => { primary.state.mode = "ok"; });

  const send = async (key: string | null, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: (await res.json()) as any };
  };
  const req = (max_tokens = 100) => ({ model: "m", max_tokens, messages: [{ role: "user", content: "abcd" }] });

  test("401 with standardized payload", async () => {
    const r = await send("nope", req());
    assert.equal(r.status, 401);
    assert.deepEqual(Object.keys(r.json.error).sort(), ["message", "request_id", "type"]);
    assert.equal(r.json.error.type, "authentication_error");
  });

  test("happy path served by primary; usage reconciled to provider's total_tokens", async () => {
    const r = await send("key-big", req(5000));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-provider"), "primary");
    const row = db.prepare(`SELECT tokens FROM request_log WHERE request_id = ?`).get(r.headers.get("x-request-id")) as any;
    assert.equal(row.tokens, 20);
  });

  test("primary 429 -> served by secondary", async () => {
    primary.state.mode = "429";
    const r = await send("key-big", req());
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-gateway-provider"), "secondary");
  });

  test("primary 500 with stack trace -> secondary; nothing leaks on total failure", async () => {
    primary.state.mode = "500";
    secondary.state.mode = "500";
    const r = await send("key-big", req());
    secondary.state.mode = "ok";
    assert.equal(r.status, 503);
    assert.equal(r.json.error.type, "upstream_unavailable");
    assert.doesNotMatch(JSON.stringify(r.json), /TypeError|\/srv|10\.0\.3\.17|primary|secondary|org-internal/);
  });

  test("concurrent burst: token limit enforced exactly (10 x 5000 = 50k)", async () => {
    // each request is estimated at 5000 tokens (1 + 4999). primary has 100ms latency
    // so all 20 reservations happen before any of them finish
    const results = await Promise.all(Array.from({ length: 20 }, () => send("key-small", req(4999))));
    const ok = results.filter((r) => r.status === 200).length;
    const limited = results.filter((r) => r.status === 429);
    assert.equal(ok, 10);
    assert.equal(limited.length, 10);
    assert.ok(Number(limited[0].headers.get("retry-after")) >= 1);
    assert.equal(limited[0].json.error.type, "rate_limit_exceeded");
  });

  test("failed requests don't consume quota", async () => {
    upsertTenant(db, "key-refund", "refund", 50_000);
    primary.state.mode = "500";
    secondary.state.mode = "500";
    for (let i = 0; i < 5; i++) await send("key-refund", req(19_999));
    primary.state.mode = "ok";
    secondary.state.mode = "ok";
    assert.equal((await send("key-refund", req(19_999))).status, 200);
  });

  test("request larger than limit -> 413", async () => {
    const r = await send("key-small", req(60_000));
    assert.equal(r.status, 413);
    assert.equal(r.json.error.type, "request_too_large");
  });

  test("invalid body -> 400 invalid_request_error", async () => {
    const r = await send("key-big", { messages: [] });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.type, "invalid_request_error");
  });
});
