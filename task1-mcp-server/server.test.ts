import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./server.ts", import.meta.url));

let child: ChildProcessWithoutNullStreams;
const rawStdoutLines: string[] = [];
const pending = new Map<number, (msg: any) => void>();
let nextId = 1;

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

before(async () => {
  child = spawn(process.execPath, [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume(); // logs go here; drain so the pipe never blocks
  createInterface({ input: child.stdout }).on("line", (line) => {
    rawStdoutLines.push(line);
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });

  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "customer-support-mcp");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
});

after(() => child.kill());

const call = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });

test("tools/list exposes both tools with JSON schemas", async () => {
  const res = await rpc("tools/list");
  const names = res.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(names, ["get_customer_record", "trigger_refund"]);
  const refund = res.result.tools.find((t: any) => t.name === "trigger_refund");
  assert.deepEqual(refund.inputSchema.required.sort(), ["amount", "customer_id", "reason"]);
});

test("get_customer_record happy path", async () => {
  const res = await call("get_customer_record", { customer_id: "CUST-00042" });
  assert.equal(res.result.structuredContent.name, "Alan Turing");
});

test("unknown customer returns tool-level isError, not a protocol error", async () => {
  const res = await call("get_customer_record", { customer_id: "CUST-99999" });
  assert.equal(res.result.isError, true);
});

for (const [label, args] of [
  ["lowercase prefix", { customer_id: "cust-00042" }],
  ["too few digits", { customer_id: "CUST-0042" }],
  ["letters in id", { customer_id: "CUST-ABCDE" }],
  ["trailing junk", { customer_id: "CUST-00042x" }],
  ["number instead of string", { customer_id: 42 }],
  ["missing field", {}],
  ["extra field", { customer_id: "CUST-00042", admin: true }],
] as const) {
  test(`get_customer_record rejects ${label} with -32602`, async () => {
    const res = await call("get_customer_record", args);
    assert.equal(res.error?.code, -32602, JSON.stringify(res));
  });
}

test("trigger_refund happy path", async () => {
  const res = await call("trigger_refund", { customer_id: "CUST-00001", amount: 19.99, reason: "Damaged on arrival" });
  assert.equal(res.result.structuredContent.status, "accepted");
});

for (const [label, args] of [
  ["zero amount", { customer_id: "CUST-00001", amount: 0, reason: "Damaged on arrival" }],
  ["negative amount", { customer_id: "CUST-00001", amount: -5, reason: "Damaged on arrival" }],
  ["string amount", { customer_id: "CUST-00001", amount: "10", reason: "Damaged on arrival" }],
  ["sub-cent amount", { customer_id: "CUST-00001", amount: 10.001, reason: "Damaged on arrival" }],
  ["short reason", { customer_id: "CUST-00001", amount: 10, reason: "too short" }],
  ["whitespace-padded reason", { customer_id: "CUST-00001", amount: 10, reason: "   short      " }],
  ["bad customer id", { customer_id: "CUST-1", amount: 10, reason: "Damaged on arrival" }],
] as const) {
  test(`trigger_refund rejects ${label} with -32602`, async () => {
    const res = await call("trigger_refund", args);
    assert.equal(res.error?.code, -32602, JSON.stringify(res));
    assert.ok(Array.isArray(res.error.data.issues));
  });
}

test("unknown tool returns -32601", async () => {
  const res = await call("drop_database", {});
  assert.equal(res.error?.code, -32601);
});

test("STDIO isolation: every stdout line is a JSON-RPC 2.0 frame", () => {
  assert.ok(rawStdoutLines.length > 0);
  for (const line of rawStdoutLines) {
    const msg = JSON.parse(line); // throws on any stray log output
    assert.equal(msg.jsonrpc, "2.0");
  }
});
