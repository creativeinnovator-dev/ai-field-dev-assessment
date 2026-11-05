import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { createGateway } from "./gateway.ts";
import { createMockMcpServer } from "./mock-mcp-server.ts";
import { signToken } from "./auth.ts";

const SECRET = "test-secret";
const admin = signToken({ sub: "alice", role: "admin" }, SECRET);
const viewer = signToken({ sub: "bob", role: "viewer" }, SECRET);

let mock: ReturnType<typeof createMockMcpServer>;
let gateway: http.Server;
let url: string;

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));

before(async () => {
  mock = createMockMcpServer();
  const mockPort = await listen(mock.server);
  gateway = createGateway({ downstreamUrl: `http://127.0.0.1:${mockPort}/mcp`, jwtSecret: SECRET });
  url = `http://127.0.0.1:${await listen(gateway)}/mcp`;
});
after(() => { gateway.close(); mock.server.close(); });
beforeEach(() => { mock.received.length = 0; });

async function post(body: unknown, token?: string, raw = false) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw ? (body as string) : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const call = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });

test("rejects missing token with 401", async () => {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 401);
  assert.equal(mock.received.length, 0);
});

test("rejects forged / tampered token with 401", async () => {
  const forged = signToken({ sub: "eve", role: "admin" }, "wrong-secret");
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, forged)).status, 401);
  const [h, , s] = viewer.split(".");
  const escalated = `${h}.${Buffer.from(JSON.stringify({ sub: "bob", role: "admin" })).toString("base64url")}.${s}`;
  assert.equal((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, escalated)).status, 401);
  assert.equal(mock.received.length, 0);
});

test("tools/list is forwarded transparently for viewer", async () => {
  const r = await post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, viewer);
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 7);
  assert.equal(r.body.result.tools.length, 2);
  assert.equal(mock.received.length, 1);
  assert.equal(mock.received[0].headers.authorization, undefined, "token must not leak downstream");
  assert.equal(mock.received[0].headers["x-gateway-role"], "viewer");
});

test("viewer calling admin_* tool gets -32001 and downstream is NOT called", async () => {
  const r = await post(call(3, "admin_reset_key"), viewer);
  assert.deepEqual(r.body, { jsonrpc: "2.0", id: 3, error: { code: -32001, message: "Unauthorized Tool Call" } });
  assert.equal(mock.received.length, 0);
});

test("admin calling admin_* tool is forwarded", async () => {
  const r = await post(call(4, "admin_reset_key"), admin);
  assert.equal(r.body.result.content[0].text, "executed admin_reset_key");
  assert.equal(mock.received.length, 1);
});

test("viewer calling non-admin tool is forwarded", async () => {
  const r = await post(call(5, "get_weather"), viewer);
  assert.ok(r.body.result);
});

test("tool name merely containing 'admin_' (not prefix) is allowed", async () => {
  const r = await post(call(6, "get_admin_stats"), viewer);
  assert.equal(mock.received.length, 1);
  assert.equal(r.body.error.code, -32602); // downstream says unknown tool - gateway didn't block it
});

test("malformed JSON returns -32700", async () => {
  const r = await post("{not json", viewer, true);
  assert.equal(r.body.error.code, -32700);
});

test("invalid JSON-RPC envelope returns -32600", async () => {
  const r = await post({ id: 1, method: "tools/list" }, viewer); // missing jsonrpc
  assert.equal(r.body.error.code, -32600);
});

test("tools/call without params.name returns -32600", async () => {
  const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, viewer);
  assert.equal(r.body.error.code, -32600);
  assert.equal(mock.received.length, 0);
});

test("batch: denied entries answered locally, allowed ones forwarded", async () => {
  const r = await post([call(1, "get_weather"), call(2, "admin_reset_key")], viewer);
  assert.equal(mock.received.length, 1);
  assert.deepEqual(mock.received[0].body.map((m: any) => m.id), [1]);
  const byId = Object.fromEntries(r.body.map((m: any) => [m.id, m]));
  assert.ok(byId[1].result);
  assert.equal(byId[2].error.code, -32001);
});

test("downstream unavailable returns sanitized 502", async () => {
  const g = createGateway({ downstreamUrl: "http://127.0.0.1:1/mcp", jwtSecret: SECRET });
  const port = await listen(g);
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { authorization: `Bearer ${viewer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  g.close();
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, -32003);
  assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|127\.0\.0\.1/);
});
