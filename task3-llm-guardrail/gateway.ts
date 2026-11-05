// LLM gateway endpoint that redacts PII from the response.
// Works with OpenAI style /v1/chat/completions, streaming and non-streaming.
import http from "node:http";
import { StreamRedactor, redact } from "./redactor.ts";

const log = (msg: string, extra?: object) =>
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }) + "\n");

export interface GuardrailOptions {
  upstreamUrl: string; // e.g. https://api.openai.com/v1/chat/completions
  upstreamApiKey?: string;
}

// Reads an SSE stream and yields the `data:` payloads. Network chunks can cut
// a line in half, so we keep the leftover in `carry`.
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let carry = "";
  for await (const text of body.pipeThrough(new TextDecoderStream() as TransformStream<Uint8Array, string>)) {
    carry += text;
    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, nl).replace(/\r$/, "");
      carry = carry.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
  if (carry.startsWith("data:")) yield carry.slice(5).trimStart();
}

export function createGuardrailGateway(opts: GuardrailOptions): http.Server {
  return http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      return res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Not found" } }));
    }

    let payload: any;
    try {
      let raw = "";
      for await (const c of req) raw += c;
      payload = JSON.parse(raw);
    } catch {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
    }

    // if the client disconnects, stop the upstream request too
    const upstreamAbort = new AbortController();
    res.on("close", () => { if (!res.writableFinished) upstreamAbort.abort(); });

    let upstream: Response;
    try {
      upstream = await fetch(opts.upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.upstreamApiKey ? { authorization: `Bearer ${opts.upstreamApiKey}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: upstreamAbort.signal,
      });
    } catch (err) {
      log("upstream_error", { err: String(err) });
      return res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Upstream provider unavailable" } }));
    }

    if (!upstream.ok || !upstream.body) {
      log("upstream_status", { status: upstream.status });
      await upstream.body?.cancel();
      return res.writeHead(upstream.status === 429 ? 429 : 502, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Upstream provider error" } }));
    }

    if (!payload.stream) {
      const json: any = await upstream.json();
      for (const choice of json.choices ?? []) {
        if (typeof choice.message?.content === "string") choice.message.content = redact(choice.message.content);
      }
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(json));
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no", // stop nginx from buffering the stream
    });
    res.flushHeaders();

    const write = async (data: string) => {
      // wait if the client is reading slower than we write
      if (!res.write(`data: ${data}\n\n`)) {
        await new Promise<void>((r) => res.once("drain", r));
      }
    };

    // one redactor per choice in case n > 1
    const redactors = new Map<number, StreamRedactor>();
    const redactorFor = (i: number) => {
      let r = redactors.get(i);
      if (!r) redactors.set(i, (r = new StreamRedactor()));
      return r;
    };
    let template: any = null; // last chunk, reused if we need to send leftover text at the end

    try {
      for await (const data of sseData(upstream.body)) {
        if (data === "[DONE]") break;

        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        template = chunk;

        let emit = false;
        for (const choice of chunk.choices ?? []) {
          const r = redactorFor(choice.index ?? 0);
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string") {
            delta.content = r.push(delta.content);
          }
          if (choice.finish_reason) {
            // this choice is done, send whatever we were still holding
            delta.content = (delta.content ?? "") + r.flush();
          }
          choice.delta = delta;
          if (delta.content || choice.finish_reason || Object.keys(delta).some((k) => k !== "content")) emit = true;
        }
        if (emit || !chunk.choices?.length) await write(JSON.stringify(chunk));
      }

      // some providers send [DONE] without a finish_reason, so flush here as well
      for (const [index, r] of redactors) {
        const rest = r.flush();
        if (rest) {
          await write(JSON.stringify({ ...template, choices: [{ index, delta: { content: rest }, finish_reason: null }] }));
        }
      }
      await write("[DONE]");
      res.end();
    } catch (err) {
      if (upstreamAbort.signal.aborted) return log("client_disconnected");
      log("stream_error", { err: String(err) });
      // headers are already sent so we can only report the error inside the stream
      res.end(`data: ${JSON.stringify({ error: { message: "Stream interrupted" } })}\n\n`);
    }
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8081);
  const upstreamUrl = process.env.UPSTREAM_URL ?? "http://localhost:9001/v1/chat/completions";
  createGuardrailGateway({ upstreamUrl, upstreamApiKey: process.env.UPSTREAM_API_KEY })
    .listen(port, () => log("listening", { port, upstreamUrl }));
}
