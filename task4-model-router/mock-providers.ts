// Fake providers for testing failover. primary on :9101, secondary on :9102.
// Switch behaviour with: POST /__mode {"mode":"429"|"slow"|"500"|"stall"|"ok"}
import http from "node:http";

export type Mode = "ok" | "429" | "slow" | "500" | "stall";

export function createMockProvider(name: string, initial: Mode = "ok", opts: { slowMs?: number; latencyMs?: number } = {}) {
  const state = { mode: initial, calls: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;

    if (req.url === "/__mode") {
      state.mode = JSON.parse(raw).mode;
      return res.writeHead(204).end();
    }
    state.calls++;
    const body = JSON.parse(raw);
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));

    switch (state.mode) {
      case "429":
        return res.writeHead(429, { "content-type": "application/json", "retry-after": "20" })
          .end(JSON.stringify({ error: { message: `Rate limit reached for org-internal-8812 on ${name}` } }));
      case "500":
        // fake stack trace, used to check the gateway doesn't pass it on
        return res.writeHead(500, { "content-type": "text/plain" })
          .end(`TypeError: Cannot read properties of undefined\n    at infer (/srv/${name}/engine/llm.py:812)\n    at 10.0.3.17:8443`);
      case "slow":
        await new Promise((r) => setTimeout(r, opts.slowMs ?? 5000));
        break;
      case "stall":
        // send headers then hang
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"id":"x",');
        return;
    }
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: `chatcmpl-${name}-${state.calls}`,
      object: "chat.completion",
      model: body.model ?? `${name}-model`,
      choices: [{ index: 0, message: { role: "assistant", content: `Hello from ${name}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));
  });
  return { server, state };
}

if (import.meta.main) {
  createMockProvider("primary").server.listen(9101, () => process.stderr.write("mock primary on :9101\n"));
  createMockProvider("secondary").server.listen(9102, () => process.stderr.write("mock secondary on :9102\n"));
}
