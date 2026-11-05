import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { StreamRedactor, redact, REDACTED, MAX_HOLD } from "./redactor.ts";
import { createGuardrailGateway } from "./gateway.ts";
import { createMockLlm, DEFAULT_TEXT } from "./mock-llm.ts";

const EXPECTED =
  `Sure! You can reach John at ${REDACTED} or on card ${REDACTED}. ` +
  `His SSN is ${REDACTED} and his order number is 1234567890123 (not a card). Anything else?`;

function streamThrough(text: string, sizes: () => number) {
  const r = new StreamRedactor();
  let out = "";
  let maxPending = 0;
  for (let i = 0; i < text.length; ) {
    const n = sizes();
    out += r.push(text.slice(i, i + n));
    maxPending = Math.max(maxPending, r.pending);
    i += n;
  }
  return { out: out + r.flush(), maxPending };
}

describe("redact()", () => {
  test("emails, SSNs, Luhn-valid cards", () => {
    assert.equal(redact(DEFAULT_TEXT), EXPECTED);
  });
  test("card formats: plain, dashed, amex", () => {
    assert.equal(redact("4111111111111111"), REDACTED);
    assert.equal(redact("5500-0000-0000-0004"), REDACTED);
    assert.equal(redact("3782 822463 10005"), REDACTED);
  });
  test("leaves non-PII numbers alone", () => {
    assert.equal(redact("call 555-123-4567 at 10:30"), "call 555-123-4567 at 10:30");
    assert.equal(redact("id 1234567890123"), "id 1234567890123"); // fails Luhn
    assert.equal(redact("1234-56-78901"), "1234-56-78901"); // not SSN shape
  });
});

describe("StreamRedactor", () => {
  test("every chunk size from 1..20 yields identical output to whole-text redaction", () => {
    for (let n = 1; n <= 20; n++) {
      assert.equal(streamThrough(DEFAULT_TEXT, () => n).out, EXPECTED, `chunk size ${n}`);
    }
  });

  test("random chunking (fuzz)", () => {
    for (let i = 0; i < 300; i++) {
      assert.equal(streamThrough(DEFAULT_TEXT, () => 1 + Math.floor(Math.random() * 12)).out, EXPECTED);
    }
  });

  test("prose is released with minimal holdback (only the partial word)", () => {
    const r = new StreamRedactor();
    assert.equal(r.push("Hello there, how are y"), "Hello there, how are ");
    assert.equal(r.pending, 1);
  });

  test("memory stays bounded on long PII-charset input", () => {
    const { out, maxPending } = streamThrough("a".repeat(10_000), () => 7);
    assert.ok(maxPending <= MAX_HOLD + 7, `pending peaked at ${maxPending}`);
    assert.equal(out.length, 10_000);
  });
});

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, () => r((s.address() as AddressInfo).port)));

describe("gateway end-to-end", () => {
  test("streams redacted SSE and first content arrives before upstream finishes", async () => {
    const llm = createMockLlm({ chunkSize: () => 3, delayMs: 5 });
    const llmPort = await listen(llm);
    const gw = createGuardrailGateway({ upstreamUrl: `http://127.0.0.1:${llmPort}/v1/chat/completions` });
    const gwPort = await listen(gw);

    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "x", stream: true, messages: [] }),
    });
    assert.equal(res.headers.get("content-type")?.startsWith("text/event-stream"), true);

    let ttft = 0;
    let content = "";
    let sawDone = false;
    let raw = "";
    for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
      raw += chunk;
      let idx;
      while ((idx = raw.indexOf("\n\n")) !== -1) {
        const data = raw.slice(6, idx);
        raw = raw.slice(idx + 2);
        if (data === "[DONE]") { sawDone = true; continue; }
        const c = JSON.parse(data).choices[0]?.delta?.content;
        if (c) { content += c; ttft ||= performance.now() - t0; }
      }
    }
    const total = performance.now() - t0;
    gw.close(); llm.close();

    assert.equal(content, EXPECTED);
    assert.ok(sawDone);
    assert.ok(ttft < total / 4, `TTFT ${ttft.toFixed(0)}ms should be far below total ${total.toFixed(0)}ms`);
  });

  test("non-streaming responses are redacted too", async () => {
    const llm = createMockLlm();
    const gw = createGuardrailGateway({ upstreamUrl: `http://127.0.0.1:${await listen(llm)}/v1/chat/completions` });
    const res = await fetch(`http://127.0.0.1:${await listen(gw)}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ stream: false, messages: [] }),
    });
    const json: any = await res.json();
    gw.close(); llm.close();
    assert.equal(json.choices[0].message.content, EXPECTED);
  });
});
