// MCP gateway: checks the bearer token, blocks admin_* tool calls for non-admins,
// and proxies everything else to the downstream MCP server.
import http from "node:http";
import { Readable } from "node:stream";
import { bearerToken, verifyToken, type Claims } from "./auth.ts";

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  UNAUTHORIZED_TOOL: -32001,
  UNAUTHENTICATED: -32002,
  UPSTREAM: -32003,
} as const;

const MAX_BODY_BYTES = 1_000_000;

type Id = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Id;
  method: string;
  params?: any;
}

const log = (msg: string, extra?: object) =>
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }) + "\n");

const rpcError = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function isValidRequest(m: any): m is JsonRpcRequest {
  return (
    m !== null &&
    typeof m === "object" &&
    !Array.isArray(m) &&
    m.jsonrpc === "2.0" &&
    typeof m.method === "string" &&
    (m.id === undefined || m.id === null || typeof m.id === "string" || typeof m.id === "number")
  );
}

// null = allowed, otherwise the error we send back
export function authorize(msg: JsonRpcRequest, claims: Claims): { code: number; message: string } | null {
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (typeof name !== "string") return { code: ERR.INVALID_REQUEST, message: "tools/call requires params.name" };
    if (name.startsWith("admin_") && claims.role !== "admin") {
      return { code: ERR.UNAUTHORIZED_TOOL, message: "Unauthorized Tool Call" };
    }
  }
  return null;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// headers that shouldn't be passed through a proxy
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "host", "content-length", "authorization",
]);

function forwardHeaders(src: http.IncomingHttpHeaders, claims: Claims): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  // don't forward the user's token, just tell downstream who it is
  out["x-gateway-user"] = claims.sub;
  out["x-gateway-role"] = claims.role;
  return out;
}

export interface GatewayOptions {
  downstreamUrl: string;
  jwtSecret: string;
  upstreamTimeoutMs?: number;
}

export function createGateway(opts: GatewayOptions): http.Server {
  const { downstreamUrl, jwtSecret, upstreamTimeoutMs = 30_000 } = opts;

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  return http.createServer(async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 405, rpcError(null, ERR.INVALID_REQUEST, "Only POST is supported"));

    const token = bearerToken(req.headers.authorization);
    const claims = token ? verifyToken(token, jwtSecret) : null;
    if (!claims) {
      res.setHeader("www-authenticate", 'Bearer error="invalid_token"');
      return sendJson(res, 401, rpcError(null, ERR.UNAUTHENTICATED, "Missing or invalid bearer token"));
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err: any) {
      if (err.status === 413) return sendJson(res, 413, rpcError(null, ERR.INVALID_REQUEST, "Request body too large"));
      return sendJson(res, 200, rpcError(null, ERR.PARSE, "Parse error"));
    }

    const isBatch = Array.isArray(body);
    const messages: unknown[] = Array.isArray(body) ? body : [body];
    if (isBatch && messages.length === 0) return sendJson(res, 200, rpcError(null, ERR.INVALID_REQUEST, "Empty batch"));

    // split into messages we answer ourselves (invalid / denied) and ones we forward
    const localResponses: object[] = [];
    const toForward: JsonRpcRequest[] = [];
    for (const m of messages) {
      if (!isValidRequest(m)) {
        localResponses.push(rpcError((m as any)?.id ?? null, ERR.INVALID_REQUEST, "Invalid Request"));
        continue;
      }
      const denial = authorize(m, claims);
      if (denial) {
        log("denied", { sub: claims.sub, role: claims.role, method: m.method, tool: m.params?.name });
        // notifications have no id so they get no response, but they're still blocked
        if (m.id !== undefined) localResponses.push(rpcError(m.id, denial.code, denial.message));
        continue;
      }
      toForward.push(m);
    }

    if (toForward.length === 0) {
      if (localResponses.length === 0) return res.writeHead(202).end();
      return sendJson(res, 200, isBatch ? localResponses : localResponses[0]);
    }

    let upstream: Response;
    try {
      upstream = await fetch(downstreamUrl, {
        method: "POST",
        headers: forwardHeaders(req.headers, claims),
        body: JSON.stringify(isBatch ? toForward : toForward[0]),
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
    } catch (err) {
      log("upstream_error", { err: String(err) });
      const errs = toForward.filter((m) => m.id !== undefined).map((m) => rpcError(m.id!, ERR.UPSTREAM, "Downstream MCP server unavailable"));
      const all = [...localResponses, ...errs];
      return sendJson(res, 502, isBatch ? all : all[0]);
    }

    // Nothing blocked: just stream the response back as is. This also covers SSE responses.
    if (localResponses.length === 0) {
      const headers: Record<string, string> = {};
      upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k)) headers[k] = v; });
      res.writeHead(upstream.status, headers);
      if (!upstream.body) return res.end();
      const stream = Readable.fromWeb(upstream.body as any);
      res.on("close", () => stream.destroy());
      return stream.pipe(res);
    }

    // Batch with some blocked calls: merge downstream results with our errors
    const text = await upstream.text();
    let downstreamResults: object[] = [];
    try {
      const parsed = text ? JSON.parse(text) : [];
      downstreamResults = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      log("upstream_bad_json", { status: upstream.status });
    }
    sendJson(res, 200, [...downstreamResults, ...localResponses]);
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const downstreamUrl = process.env.DOWNSTREAM_URL ?? "http://localhost:9000/mcp";
  const jwtSecret = process.env.JWT_SECRET ?? "dev-secret-change-me";
  createGateway({ downstreamUrl, jwtSecret }).listen(port, () =>
    log("listening", { port, downstreamUrl }),
  );
}
