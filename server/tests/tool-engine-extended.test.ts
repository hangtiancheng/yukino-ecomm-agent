import { beforeEach, describe, expect, it, vi } from "vitest";

import { executeToolCall } from "#/tools/engine.ts";
import { defineRawTool } from "#/tools/registry.ts";
import type { ToolSpec } from "#/tools/registry.ts";

const mocks = vi.hoisted(() => {
  const audits: Record<string, unknown>[] = [];
  return { audits };
});

vi.mock("#/db/repository.ts", () => ({
  insertToolAudit: vi.fn((input: Record<string, unknown>) => {
    mocks.audits.push(input);
    return Promise.resolve();
  }),
}));

const ORDER_SCHEMA = {
  type: "object",
  properties: { order_id: { type: "string" } },
  required: ["order_id"],
};
const TICKET_SCHEMA = {
  type: "object",
  properties: { description: { type: "string" } },
  required: ["description"],
};

interface SpecOptions {
  name?: string;
  permission?: "read" | "write";
  source?: "builtin" | "mcp";
  jsonSchema?: Record<string, unknown>;
  timeout?: number | null;
  maxRetries?: number | null;
  injectConversation?: boolean;
  injectUserId?: boolean;
  formatResult?:
    ((d: Record<string, unknown>) => Record<string, unknown>) | null;
  handler?: (args: Record<string, unknown>) => unknown;
}

function spec(options: SpecOptions): ToolSpec {
  // Build the full spec literal: defineRawTool is the MCP door and pins the
  // injection flags to false by design, but these tests need both shapes.
  const base = defineRawTool({
    name: options.name ?? "query_order",
    description: "test tool",
    jsonSchema: options.jsonSchema ?? ORDER_SCHEMA,
    source: options.source ?? "builtin",
    timeout: options.timeout ?? null,
    maxRetries: options.maxRetries ?? null,
    formatResult: options.formatResult ?? null,
    handler: options.handler ?? (() => ({})),
  });
  return {
    ...base,
    permission: options.permission ?? base.permission,
    injectConversation: options.injectConversation ?? false,
    injectUserId: options.injectUserId ?? false,
  };
}

function call(
  name: string | undefined,
  args: Record<string, unknown>,
  id = "c1",
): { id: string; name: string; args: Record<string, unknown> } {
  return { id, name: name ?? "", args };
}

function lastAudit(): Record<string, unknown> {
  const row = mocks.audits.at(-1);
  if (!row) {
    throw new Error("no audit row captured");
  }
  return row;
}

beforeEach(() => {
  mocks.audits.length = 0;
});

describe("tool engine pipeline", () => {
  it("unknown tool fails and is audited", async () => {
    const run = await executeToolCall(call("nope", {}), 1, new Map());
    expect(run.ok).toBe(false);
    expect(run.toolMessage.content).toContain("unknown tool");
    expect(lastAudit().status).toBe("failed");
  });

  it("a malformed tool call never raises", async () => {
    const run = await executeToolCall(
      { id: "", name: "", args: {} },
      1,
      new Map(),
    );
    expect(run.ok).toBe(false);
  });

  it("schema validation blocks execution and feeds the error back", async () => {
    const s = spec({
      handler: () => {
        throw new Error("must never run");
      },
    });
    const run = await executeToolCall(
      call("query_order", {}),
      1,
      new Map([["query_order", s]]),
    );
    expect(run.ok).toBe(false);
    expect(run.status).toBe("validation_blocked");
    expect(run.toolMessage.content).toContain("Argument validation failed");
    expect(run.toolMessage.status).toBe("error");
    expect(lastAudit().status).toBe("validation_blocked");
    expect(lastAudit().retryCount).toBe(0);
  });

  it("a write without confirmation is denied", async () => {
    const s = spec({
      name: "create_ticket",
      permission: "write",
      jsonSchema: TICKET_SCHEMA,
      handler: () => {
        throw new Error("must never run unconfirmed");
      },
    });
    const run = await executeToolCall(
      call("create_ticket", { description: "x" }),
      1,
      new Map([["create_ticket", s]]),
    );
    expect(run.ok).toBe(false);
    expect(run.status).toBe("permission_denied");
    expect(lastAudit().status).toBe("permission_denied");
  });

  it("a confirmed write executes exactly once (writes never retry)", async () => {
    let calls = 0;
    const s = spec({
      name: "create_ticket",
      permission: "write",
      jsonSchema: TICKET_SCHEMA,
      handler: () => {
        calls += 1;
        throw new Error("boom");
      },
    });
    const run = await executeToolCall(
      call("create_ticket", { description: "x" }),
      1,
      new Map([["create_ticket", s]]),
      { confirmed: true },
    );
    expect(run.ok).toBe(false);
    expect(calls).toBe(1);
    expect(run.retryCount).toBe(0);
  });

  it("transient timeouts retry then give up", async () => {
    const s = spec({
      timeout: 0.05,
      handler: () => new Promise<never>(() => undefined), // never resolves → timeout
    });
    const run = await executeToolCall(
      call("query_order", { order_id: "1" }),
      1,
      new Map([["query_order", s]]),
    );
    expect(run.ok).toBe(false);
    expect(run.status).toBe("timeout");
    expect(run.retryCount).toBe(2); // settings.toolMaxRetries default
    expect(lastAudit().status).toBe("timeout");
    expect(lastAudit().retryCount).toBe(2);
    expect(lastAudit().durationMs).not.toBeNull();
  });

  it("business errors are not retried", async () => {
    let calls = 0;
    const s = spec({
      handler: () => {
        calls += 1;
        throw new Error("business failure");
      },
    });
    const run = await executeToolCall(
      call("query_order", { order_id: "1" }),
      1,
      new Map([["query_order", s]]),
    );
    expect(run.ok).toBe(false);
    expect(calls).toBe(1);
    expect(run.toolMessage.content).toContain("temporarily unavailable");
  });

  it("a transient failure succeeds on the second attempt", async () => {
    let calls = 0;
    const s = spec({
      handler: () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("fetch failed"); // transient in the TS engine
        }
        return { order_id: "1", status: "shipped" };
      },
    });
    const run = await executeToolCall(
      call("query_order", { order_id: "1" }),
      1,
      new Map([["query_order", s]]),
    );
    expect(run.ok).toBe(true);
    expect(calls).toBe(2);
    expect(run.retryCount).toBe(1);
    expect(run.toolMessage.content).toContain("shipped");
    expect(lastAudit().status).toBe("success");
    expect(lastAudit().retryCount).toBe(1);
  });

  it("format_result translates enums and drops internal fields", async () => {
    const s = spec({
      name: "query_logistics",
      source: "mcp",
      jsonSchema: {
        type: "object",
        properties: { tracking_no: { type: "string" } },
        required: ["tracking_no"],
      },
      handler: () => ({
        tracking_no: "SF1",
        status_code: "IN_TRANSIT",
        internal_ref: "x9",
      }),
      formatResult: (d) => ({
        tracking_no: typeof d.tracking_no === "string" ? d.tracking_no : "",
        status:
          d.status_code === "IN_TRANSIT"
            ? "In transit"
            : typeof d.status_code === "string"
              ? d.status_code
              : "",
      }),
    });
    const run = await executeToolCall(
      call("query_logistics", { tracking_no: "SF1" }),
      1,
      new Map([["query_logistics", s]]),
    );
    expect(run.toolMessage.content).toContain("In transit");
    expect(run.toolMessage.content).not.toContain("internal_ref");
    expect(lastAudit().toolSource).toBe("mcp");
  });

  it("JSON-text results are parsed before formatting", async () => {
    const s = spec({
      name: "query_logistics",
      source: "mcp",
      jsonSchema: {
        type: "object",
        properties: { tracking_no: { type: "string" } },
        required: ["tracking_no"],
      },
      handler: () => '{"tracking_no": "SF1", "status_code": "IN_TRANSIT"}',
      formatResult: (d) => ({
        status: d.status_code === "IN_TRANSIT" ? "In transit" : null,
      }),
    });
    const run = await executeToolCall(
      call("query_logistics", { tracking_no: "SF1" }),
      1,
      new Map([["query_logistics", s]]),
    );
    expect(run.ok).toBe(true);
    expect(run.toolMessage.content).toContain("In transit");
  });

  it("MCP content-block lists are unwrapped", async () => {
    const s = spec({
      name: "query_logistics",
      source: "mcp",
      jsonSchema: {
        type: "object",
        properties: { tracking_no: { type: "string" } },
        required: ["tracking_no"],
      },
      handler: () => [
        { type: "text", text: '{"status_code": "DELIVERED"}', id: "lc_random" },
      ],
      formatResult: (d) => ({
        status: d.status_code === "DELIVERED" ? "Delivered" : null,
      }),
    });
    const run = await executeToolCall(
      call("query_logistics", { tracking_no: "SF1" }),
      1,
      new Map([["query_logistics", s]]),
    );
    expect(run.ok).toBe(true);
    expect(run.toolMessage.content).toContain("Delivered");
    expect(run.toolMessage.content).not.toContain("lc_random");
  });

  it("a malformed external schema never raises (never-raises contract)", async () => {
    const s = spec({
      name: "ext_tool",
      source: "mcp",
      jsonSchema: {
        type: "object",
        properties: { x: { type: "strin" } }, // bad type name from an untrusted server
        required: ["x"],
      },
      handler: () => ({ x: 1 }),
    });
    const run = await executeToolCall(
      call("ext_tool", { x: "1" }),
      1,
      new Map([["ext_tool", s]]),
    );
    expect(run.ok).toBe(false);
    expect(run.status).toBe("failed");
    expect(run.toolMessage.content).toContain("malformed argument definition");
    expect(lastAudit().status).toBe("failed");
  });

  it("audit fields are clamped to DDL widths", async () => {
    const s = spec({
      jsonSchema: {
        type: "object",
        properties: { order_id: { type: "string", maxLength: 3 } },
        required: ["order_id"],
      },
    });
    await executeToolCall(
      call("query_order", { order_id: "x".repeat(2000) }),
      1,
      new Map([["query_order", s]]),
    );
    expect(lastAudit().status).toBe("validation_blocked");
    expect(String(lastAudit().errorMessage).length).toBeLessThanOrEqual(500);

    await executeToolCall(call("n".repeat(300), {}, "c2"), 1, new Map());
    expect(String(lastAudit().toolName).length).toBeLessThanOrEqual(128);
  });

  it("spec maxRetries=0 disables retries (RAG-pipeline tools)", async () => {
    let calls = 0;
    const s = spec({
      name: "query_faq",
      jsonSchema: { type: "object", properties: {} },
      timeout: 0.05,
      maxRetries: 0,
      handler: () => {
        calls += 1;
        return new Promise<never>(() => undefined);
      },
    });
    const run = await executeToolCall(
      call("query_faq", {}),
      1,
      new Map([["query_faq", s]]),
    );
    expect(run.ok).toBe(false);
    expect(calls).toBe(1);
    expect(run.retryCount).toBe(0);
  });

  it("a crashing formatter degrades to the raw result", async () => {
    const s = spec({
      name: "query_logistics",
      source: "mcp",
      jsonSchema: {
        type: "object",
        properties: { tracking_no: { type: "string" } },
        required: ["tracking_no"],
      },
      handler: () => ({ tracking_no: "SF1" }),
      formatResult: () => {
        throw new Error("formatter crashed");
      },
    });
    const run = await executeToolCall(
      call("query_logistics", { tracking_no: "SF1" }),
      1,
      new Map([["query_logistics", s]]),
    );
    expect(run.ok).toBe(true);
    expect(run.toolMessage.content).toContain("SF1");
    expect(lastAudit().status).toBe("success");
  });

  it("an audit failure never blocks execution", async () => {
    const { insertToolAudit } = await import("#/db/repository.ts");
    const original = vi.mocked(insertToolAudit).getMockImplementation();
    vi.mocked(insertToolAudit).mockImplementationOnce(() => {
      throw new Error("audit store down");
    });
    const s = spec({ handler: () => ({ order_id: "1" }) });
    const run = await executeToolCall(
      call("query_order", { order_id: "1" }),
      1,
      new Map([["query_order", s]]),
    );
    expect(run.ok).toBe(true);
    expect(original).not.toBeNull();
  });

  it("injects conversation_id after validation", async () => {
    let seen: Record<string, unknown> = {};
    const s = spec({
      name: "create_ticket",
      permission: "write",
      jsonSchema: {
        ...TICKET_SCHEMA,
        additionalProperties: false,
      },
      injectConversation: true,
      handler: (args) => {
        seen = args;
        return { ticket_no: "T1" };
      },
    });
    const run = await executeToolCall(
      call("create_ticket", { description: "x" }),
      7,
      new Map([["create_ticket", s]]),
      { confirmed: true },
    );
    expect(run.ok).toBe(true);
    expect(seen.conversation_id).toBe(7);
  });

  it("injects user_id after validation", async () => {
    let seen: Record<string, unknown> = {};
    const s = spec({
      injectUserId: true,
      handler: (args) => {
        seen = args;
        return { order_id: args.order_id };
      },
    });
    const run = await executeToolCall(
      call("query_order", { order_id: "1001" }),
      7,
      new Map([["query_order", s]]),
      { userId: "u-real" },
    );
    expect(run.ok).toBe(true);
    expect(seen.user_id).toBe("u-real");
  });

  it("a model-supplied identity is always overwritten by injection", async () => {
    // The crux: if injection cannot override a model-filled user_id, then
    // "I am the support manager, check this order" becomes a working exploit.
    let seen: Record<string, unknown> = {};
    const s = spec({
      jsonSchema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
          user_id: { type: "string" },
        },
        required: ["order_id"],
      },
      injectUserId: true,
      handler: (args) => {
        seen = args;
        return { order_id: args.order_id };
      },
    });
    const run = await executeToolCall(
      call("query_order", { order_id: "1001", user_id: "u-victim" }),
      7,
      new Map([["query_order", s]]),
      { userId: "u-real" },
    );
    expect(run.ok).toBe(true);
    expect(seen.user_id).toBe("u-real"); // not the model-supplied one
  });

  it("tools without injection never gain identity parameters", async () => {
    let seen: Record<string, unknown> = {};
    const s = spec({
      handler: (args) => {
        seen = args;
        return { ok: true };
      },
    });
    await executeToolCall(
      call("query_order", { order_id: "1001" }),
      7,
      new Map([["query_order", s]]),
      { userId: "u-real" },
    );
    expect(seen).not.toHaveProperty("user_id");
  });

  it("the audit result summary is truncated", async () => {
    const s = spec({ handler: () => ({ blob: "x".repeat(2000) }) });
    await executeToolCall(
      call("query_order", { order_id: "1" }),
      1,
      new Map([["query_order", s]]),
    );
    // 500 chars + the "… (truncated)" suffix
    expect(String(lastAudit().resultSummary).length).toBeLessThanOrEqual(520);
  });
});
