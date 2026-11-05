// Fake OpenAI style provider. Sends the text in small random chunks so the
// PII usually ends up split between chunks.
import http from "node:http";

export const DEFAULT_TEXT =
  "Sure! You can reach John at john.doe@example.com or on card 4111 1111 1111 1111. " +
  "His SSN is 123-45-6789 and his order number is 1234567890123 (not a card). Anything else?";

export interface MockLlmOptions {
  text?: string;
  chunkSize?: () => number;
  delayMs?: number;
}

export function createMockLlm(opts: MockLlmOptions = {}) {
  const text = opts.text ?? DEFAULT_TEXT;
  const chunkSize = opts.chunkSize ?? (() => 1 + Math.floor(Math.random() * 4));
  const delayMs = opts.delayMs ?? 15;

  return http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "mock-1" };

    if (!body.stream) {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        ...base, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      }));
    }

    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    for (let i = 0; i < text.length && !res.destroyed; ) {
      const n = chunkSize();
      send({ ...base, choices: [{ index: 0, delta: { content: text.slice(i, i + n) }, finish_reason: null }] });
      i += n;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  });
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 9001);
  createMockLlm().listen(port, () => process.stderr.write(`mock LLM on :${port}\n`));
}
