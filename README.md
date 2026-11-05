# AI Field Developer assessment

All 4 tasks are in TypeScript. Node 23.6+ can run .ts files directly, so there's no build step.

```
npm install
npm test
npm run typecheck
```

Folders:

- `task1-mcp-server` - MCP server over stdio
- `task2-mcp-gateway` - MCP gateway with token auth and admin tool filtering
- `task3-llm-guardrail` - LLM proxy that redacts PII from the stream
- `task4-model-router` - token rate limiter + fallback between providers (sqlite)

Each task has a mock server so it can be tried without real API keys.


## Task 1 - MCP server

```
npm run task1
```

Easiest way to try it is the MCP inspector:

```
npx @modelcontextprotocol/inspector node task1-mcp-server/server.ts
```

Notes:

- I used the low level `Server` class instead of `McpServer`. McpServer catches validation errors
  and returns them as normal tool results with `isError: true`, but the task asks for JSON-RPC error codes.
  Invalid input returns -32602 (with the list of issues in `data`), unknown tool returns -32601.
- "Customer not found" is returned as a tool result with `isError`, since the request itself was valid.
- Logs only go to stderr. I also redirect console.log to stderr in case a library prints something.
  There's a test that checks every line on stdout is valid JSON-RPC.
- customer_id has to be `CUST-` + 5 digits. The doc says CUST-XXXXX so I assumed digits.
- amount must be > 0, finite and max 2 decimals. reason is trimmed before checking the length.


## Task 2 - MCP gateway

```
npm run task2:mock      # downstream server on 9000
npm run task2           # gateway on 8080
npm run -s task2:token viewer     # prints a token (or "admin")
```

Example (PowerShell):

```
$t = node task2-mcp-gateway/mint-token.ts viewer
Invoke-RestMethod http://localhost:8080/mcp -Method Post -Headers @{Authorization="Bearer $t"} `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_reset_key"}}'
```

Notes:

- The token is a HS256 JWT with `sub` and `role`. I wrote the verify with node:crypto instead of adding a library.
- If a non-admin calls an `admin_*` tool the gateway returns -32001 itself and the request never reaches
  the downstream server (there's a test for that).
- The user's token isn't forwarded downstream. The gateway sends `x-gateway-user` / `x-gateway-role` instead.
- Allowed requests are piped through, so it also works if the downstream answers with SSE.
- Batches work too: blocked calls get an error, the rest are forwarded together.


## Task 3 - PII redaction on the stream

```
npm run task3:mock      # fake LLM on 9001
npm run task3           # gateway on 8081
curl.exe -N http://localhost:8081/v1/chat/completions -d '{\"stream\":true,\"messages\":[]}'
```

Set `UPSTREAM_URL` and `UPSTREAM_API_KEY` to use a real OpenAI compatible provider.

The main problem is that PII can be split between chunks, e.g. `john@exa` + `mple.com`.

The simple fix would be to always hold back the last N characters, but that delays every token.
Instead `redactor.ts` only holds back the end of the text that could still become a match. All the patterns
only use letters, digits and `._%+-@` (and single spaces in card numbers), so it walks back from the end until
it finds a character that can't be in any match. Everything before that is sent straight away. In normal
text that's just the last unfinished word.

The buffer is capped at 254 chars (max email length), so memory doesn't grow with the response size.
Card numbers are checked with Luhn so other long numbers aren't redacted.

Other things handled: one redactor per choice (n > 1), backpressure (waits for drain), and aborting the
upstream request if the client disconnects.


## Task 4 - rate limiter and fallback

```
npm run task4:mock      # primary on 9101, secondary on 9102
npm run task4           # gateway on 8082, db in task4-model-router/data/gateway.db
```

Demo tenant key is `tenant-demo-key`. To make the primary fail:

```
Invoke-RestMethod http://localhost:9101/__mode -Method Post -Body '{"mode":"429"}'   # or slow / 500 / stall
```

The `x-gateway-provider` response header shows which provider answered.

Rate limiter:

- Sliding window over the last 60s, one row per request in sqlite (`token_usage`).
- Before calling the model we reserve an estimate (prompt chars / 4 + max_tokens). After the call it's
  updated to the real `usage.total_tokens`. If both providers fail the reservation is removed.
- The check and insert run in a `BEGIN IMMEDIATE` transaction so concurrent requests can't go over the limit,
  even with multiple processes on the same db file.
- Retry-After is calculated from when enough old usage drops out of the window.
- API keys are stored hashed.

Fallback:

- Falls back on 429, timeout (3s), 5xx and connection errors. Other 4xx errors are returned directly.
- The timeout covers reading the body too, so a provider that sends headers and then hangs still times out.
- On timeout the request is aborted, so a late response from the primary can't be used.

Errors are always returned as `{ "error": { "type", "message", "request_id" } }`. Upstream error bodies and
stack traces are only written to the logs and the `request_log` table.


## Not done / could be improved

- Task 3 only covers email, SSN and cards. Phone numbers, IBAN, names etc. would need more patterns or NER.
- Task 4 doesn't support streaming yet.
- For more than one server, the rate limiter should move to Redis.
- Task 2 could also filter `tools/list` so viewers don't see admin tools.
