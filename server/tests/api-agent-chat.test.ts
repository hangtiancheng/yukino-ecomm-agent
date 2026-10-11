import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as DbExports from "#/db/client.ts";
import { readJson } from "#tests/helpers/json.ts";
import { provisionTestDatabase } from "#tests/helpers/test-db.ts";

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  streamTurn: vi.fn(),
}));

vi.mock("#/graph/runtime.ts", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("#/graph/runtime.ts");
  return {
    ...actual,
    runTurn: mocks.runTurn,
    streamTurn: mocks.streamTurn,
  };
});

let app: Hono;
let db: typeof DbExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_agent_chat");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const agentSchema = z.object({
  conversation_id: z.number(),
  answer: z.string(),
  tool_calls: z.array(
    z.object({ id: z.string(), name: z.string(), args: z.unknown() }),
  ),
  tool_results: z.array(
    z.object({
      tool_call_id: z.string(),
      name: z.string(),
      ok: z.boolean(),
      content: z.string(),
    }),
  ),
  suggested_actions: z.array(z.object({ type: z.string() })),
  interrupt: z.unknown().nullable(),
});

describe("/api/agent", () => {
  it("rebuilds the tool trace from the final state", async () => {
    mocks.runTurn.mockResolvedValue({
      conversation_id: 7,
      state: {
        messages: [
          new HumanMessage("where is order 1001"),
          new AIMessage({
            content: "",
            tool_calls: [
              {
                id: "c1",
                name: "query_order",
                args: { order_id: "1001" },
                type: "tool_call",
              },
            ],
          }),
          new ToolMessage({
            content: '{"status":"shipped"}',
            tool_call_id: "c1",
            name: "query_order",
          }),
          new AIMessage("Your order has shipped."),
        ],
        suggestedActions: [{ type: "transfer_human" }],
        answer: "",
      },
      interrupt: null,
    });
    const res = await post("/api/agent", {
      user_id: "u1",
      message: "where is order 1001",
    });
    expect(res.status).toBe(200);
    const body = await readJson(res, agentSchema);
    expect(body.conversation_id).toBe(7);
    expect(body.answer).toBe("Your order has shipped.");
    expect(body.tool_calls).toEqual([
      { id: "c1", name: "query_order", args: { order_id: "1001" } },
    ]);
    expect(body.tool_results).toEqual([
      {
        tool_call_id: "c1",
        name: "query_order",
        ok: true,
        content: '{"status":"shipped"}',
      },
    ]);
    expect(body.suggested_actions).toEqual([{ type: "transfer_human" }]);
    expect(body.interrupt).toBeNull();
  });

  it("maps a missing conversation to 404", async () => {
    const { ConversationNotFound } = await import("#/graph/runtime.ts");
    mocks.runTurn.mockRejectedValue(new ConversationNotFound(99));
    const res = await post("/api/agent", {
      user_id: "u1",
      message: "hi",
      conversation_id: 99,
    });
    expect(res.status).toBe(404);
  });

  it("maps upstream failures to 502", async () => {
    mocks.runTurn.mockRejectedValue(new Error("model exploded"));
    const res = await post("/api/agent", { user_id: "u1", message: "hi" });
    expect(res.status).toBe(502);
  });
});

interface StreamEvent {
  type: string;
  text?: string;
  items?: unknown;
  name?: string;
  kind?: string;
  conversation_id?: number;
  orders?: unknown;
  preview?: unknown;
}

function eventStream(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  async function* gen(): AsyncGenerator<StreamEvent> {
    for (const ev of events) {
      await Promise.resolve();
      yield ev;
    }
  }
  return gen();
}

describe("/api/chat SSE", () => {
  it("streams deltas, citations, actions and done", async () => {
    mocks.streamTurn.mockReturnValue(
      eventStream([
        { type: "delta", text: "Hello " },
        { type: "delta", text: "there" },
        {
          type: "citations",
          items: [{ n: 1, id: 5, question: "q", answer: "a" }],
        },
        { type: "tool", name: "query_order" },
        { type: "actions", items: [{ type: "transfer_human" }] },
        { type: "done", conversation_id: 3 },
      ]),
    );
    const res = await post("/api/chat", { user_id: "u1", message: "hi" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"delta":"Hello "');
    expect(text).toContain('"event":"citations"');
    expect(text).toContain('"event":"tool","name":"query_order"');
    expect(text).toContain('"event":"actions"');
    expect(text).toContain('"event":"done","conversation_id":3');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("passes interrupt payloads through", async () => {
    mocks.streamTurn.mockReturnValue(
      eventStream([
        {
          type: "interrupt",
          kind: "select_order",
          conversation_id: 4,
          orders: [{ order_id: "1001" }],
        },
      ]),
    );
    const res = await post("/api/chat", { user_id: "u1", message: "refund" });
    const text = await res.text();
    expect(text).toContain('"event":"interrupt"');
    expect(text).toContain('"kind":"select_order"');
    expect(text).toContain('"orders"');
    expect(text).not.toContain('"event":"done"');
  });

  it("emits an error event when the stream fails", async () => {
    mocks.streamTurn.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<StreamEvent>> => {
          await Promise.resolve();
          throw new Error("graph exploded");
        },
      }),
    }));
    const res = await post("/api/chat", { user_id: "u1", message: "hi" });
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(text).toContain("temporarily unavailable");
  });
});
