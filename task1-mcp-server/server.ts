#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// stdout belongs to the transport, so all logging goes to stderr.
const log = (level: string, msg: string, extra?: unknown) =>
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra ? { extra } : {}) }) + "\n",
  );

// In case something (us or a dependency) calls console.log by accident.
for (const m of ["log", "info", "debug"] as const) {
  console[m] = (...args: unknown[]) => log("console", args.map(String).join(" "));
}

export const CustomerId = z
  .string()
  .regex(/^CUST-\d{5}$/, "customer_id must match CUST-XXXXX (5 digits), e.g. CUST-00042");

export const GetCustomerRecordInput = z.strictObject({
  customer_id: CustomerId,
});

export const TriggerRefundInput = z.strictObject({
  customer_id: CustomerId,
  amount: z
    .number()
    .finite()
    .positive("amount must be > 0")
    .max(1_000_000, "amount exceeds refund ceiling")
    .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "amount must have at most 2 decimal places"),
  reason: z.string().trim().min(10, "reason must be at least 10 characters").max(500),
});

// fake data for the demo
const CUSTOMERS = new Map<string, Record<string, unknown>>([
  ["CUST-00001", { customer_id: "CUST-00001", name: "Ada Lovelace", tier: "gold", balance: 120.5 }],
  ["CUST-00042", { customer_id: "CUST-00042", name: "Alan Turing", tier: "silver", balance: 15 }],
]);

const notFound = (id: string) => ({
  isError: true,
  content: [{ type: "text" as const, text: `Customer ${id} not found` }],
});

const tools = {
  get_customer_record: {
    description: "Fetch a customer record by ID.",
    schema: GetCustomerRecordInput,
    handler: async ({ customer_id }: z.infer<typeof GetCustomerRecordInput>) => {
      const record = CUSTOMERS.get(customer_id);
      // not found is a normal tool result, the request itself was fine
      if (!record) return notFound(customer_id);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(record) }],
        structuredContent: record,
      };
    },
  },
  trigger_refund: {
    description: "Issue a refund to a customer.",
    schema: TriggerRefundInput,
    handler: async (args: z.infer<typeof TriggerRefundInput>) => {
      if (!CUSTOMERS.has(args.customer_id)) return notFound(args.customer_id);
      const refund = {
        refund_id: `RF-${Date.now().toString(36).toUpperCase()}`,
        status: "accepted",
        ...args,
      };
      log("info", "refund issued", refund);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(refund) }],
        structuredContent: refund,
      };
    },
  },
} as const;

type ToolName = keyof typeof tools;

export function createServer() {
  // Using the low level Server on purpose. McpServer turns validation errors into
  // isError results, but we want proper JSON-RPC errors (-32602).
  const server = new Server(
    { name: "customer-support-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema) as { type: "object"; [k: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;

    if (!Object.hasOwn(tools, name)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    const tool = tools[name as ToolName];

    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for ${name}`, {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, code: i.code })),
      });
    }

    try {
      return await (tool.handler as (a: unknown) => Promise<unknown>)(parsed.data) as never;
    } catch (err) {
      log("error", "tool handler failed", { name, err: String(err) });
      throw new McpError(ErrorCode.InternalError, "Internal error while executing tool");
    }
  });

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log("info", "customer-support-mcp listening on stdio");

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  process.on("uncaughtException", (err) => log("fatal", "uncaught exception", { err: String(err) }));
  main().catch((err) => {
    log("fatal", "startup failed", { err: String(err) });
    process.exit(1);
  });
}
