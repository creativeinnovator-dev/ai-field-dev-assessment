// Fake downstream MCP server (JSON-RPC over HTTP). Keeps a list of what it
// received so the tests can check what got through the gateway.
import http from "node:http";

const TOOLS = [
  { name: "get_weather", description: "Weather lookup", inputSchema: { type: "object", properties: { city: { type: "string" } } } },
  { name: "admin_reset_key", description: "Rotate an API key", inputSchema: { type: "object", properties: { key_id: { type: "string" } } } },
];

function handle(msg: any) {
  switch (msg.method) {
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
    case "tools/call":
      if (!TOOLS.some((t) => t.name === msg.params?.name)) {
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${msg.params?.name}` } };
      }
      return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `executed ${msg.params.name}` }] } };
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
  }
}

export function createMockMcpServer() {
  const received: any[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    received.push({ headers: req.headers, body });
    const out = Array.isArray(body) ? body.filter((m) => m.id !== undefined).map(handle) : handle(body);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
  return { server, received };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 9000);
  createMockMcpServer().server.listen(port, () => process.stderr.write(`mock MCP server on :${port}\n`));
}
