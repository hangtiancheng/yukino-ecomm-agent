import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { settings } from "#/config.ts";
import {
  agentMessages,
  agentTools,
  classifyIntent,
  confidenceCheck,
  extractOrderId,
  fetchOrder,
  logNode,
  resolveReference,
  retrieveKnowledge,
  retrievePolicy,
} from "#/graph/nodes.ts";
import { ConversationState } from "#/graph/state.ts";
import type { GraphState } from "#/graph/state.ts";
import { contentText } from "#tests/helpers/json.ts";

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  corefResolve: vi.fn(),
  understand: vi.fn(),
  expandQueries: vi.fn(),
  searchKnowledge: vi.fn(),
  checkSufficient: vi.fn(),
  appendMessage: vi.fn(),
  insertLowConfidence: vi.fn(),
  getAllSpecs: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  executeToolCall: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("#/core/intent.ts", () => ({ classify: mocks.classify }));
vi.mock("#/core/coref.ts", () => ({ resolve: mocks.corefResolve }));
vi.mock("#/core/query-understanding.ts", () => ({
  understand: mocks.understand,
  expandQueries: mocks.expandQueries,
}));
vi.mock("#/core/retrieval.ts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "#/core/retrieval.ts",
  );
  return { ...actual, searchKnowledge: mocks.searchKnowledge };
});
vi.mock("#/core/selfcheck.ts", () => ({
  checkSufficient: mocks.checkSufficient,
}));
vi.mock("#/db/repository.ts", () => ({
  appendMessage: mocks.appendMessage,
  insertLowConfidence: mocks.insertLowConfidence,
}));
vi.mock("#/tools/registry.ts", () => ({ getAllSpecs: mocks.getAllSpecs }));
vi.mock("#/tools/engine.ts", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("#/tools/engine.ts");
  return { ...actual, executeToolCall: mocks.executeToolCall };
});

function state(overrides: Partial<GraphState> = {}): GraphState {
  return {
    messages: [],
    summary: "",
    summaryUptoMsgId: 0,
    layer1FromMsgId: 0,
    userId: "u1",
    conversationId: 1,
    intent: "",
    resolvedQuery: "",
    intentConfidence: 0,
    orderId: "",
    orderData: {},
    route: "",
    evidence: "",
    citations: [],
    evidenceStrong: false,
    evidenceConfidence: 0,
    fallbackSource: "",
    retrievedSnapshot: [],
    answer: "",
    steps: 0,
    tokensUsed: 0,
    suggestedActions: [],
    trace: {},
    ...overrides,
  };
}

function hit(id: number, score: number): Record<string, unknown> {
  return {
    id,
    score,
    question: `q${id}`,
    answer: `a${id}`,
    section_path: `s${id}`,
    content_type: "faq",
    category: "cat",
    rerank_score: score,
  };
}

const interruptSchema = z.object({
  __interrupt__: z.array(
    z.looseObject({ value: z.record(z.string(), z.unknown()) }),
  ),
});

function toolMessageOf(value: unknown): ToolMessage {
  const msgs = z.object({ messages: z.array(z.unknown()) }).parse(value);
  const last = msgs.messages.at(-1);
  if (!(last instanceof ToolMessage)) {
    throw new Error("expected a ToolMessage in the node output");
  }
  return last;
}

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    m.mockReset();
  }
  mocks.appendMessage.mockResolvedValue(1);
  mocks.insertLowConfidence.mockResolvedValue(1);
});

describe("extract_order_id", () => {
  it("finds 4+ digit runs and rejects shorter ones", () => {
    expect(extractOrderId("the logistics of order 1001")).toBe("1001");
    expect(extractOrderId("the one ending 20260701")).toBe("20260701");
    expect(extractOrderId("I want a refund")).toBeNull();
  });
});

describe("fetch_order", () => {
  it("uses the order id from the query when it belongs to the user", () => {
    const mine = "1001"; // demo order, owned by everyone
    const out = fetchOrder(
      state({ resolvedQuery: `can order ${mine} be returned`, userId: "u1" }),
    );
    expect(out.orderId).toBe(mine);
    expect(out.orderData?.order_id).toBe(mine);
    expect(out.trace).toEqual({ fetch_order: { order_id: mine } });
  });
});

describe("fetch_order interrupts (minimal compiled graph)", () => {
  function buildFetchGraph() {
    const builder = new StateGraph(ConversationState)
      .addNode("fetch_order", fetchOrder)
      .addEdge(START, "fetch_order")
      .addEdge("fetch_order", END);
    return builder.compile({ checkpointer: new MemorySaver() });
  }

  it("interrupts with the order picker when no order id is given", async () => {
    const graph = buildFetchGraph();
    const out = await graph.invoke(
      { ...state(), resolvedQuery: "I want a refund" },
      { configurable: { thread_id: "t-fetch" } },
    );
    const parsed = interruptSchema.parse(out);
    const value = parsed.__interrupt__[0]?.value;
    expect(value?.type).toBe("select_order");
    const orders = z
      .array(z.object({ order_id: z.string() }))
      .parse(value?.orders);
    expect(orders.some((o) => o.order_id === "1001")).toBe(true);
  });

  it("also interrupts when the user quotes somebody else's order", async () => {
    // The refund sub-flow is deterministic and never passes agent_tools, so
    // the ownership gate inside the tools cannot see it; a foreign order id
    // must fall back to the picker exactly like a missing one.
    const graph = buildFetchGraph();
    const out = await graph.invoke(
      { ...state(), resolvedQuery: "refund order 888888" },
      { configurable: { thread_id: "t-foreign" } },
    );
    const parsed = interruptSchema.parse(out);
    expect(parsed.__interrupt__[0]?.value.type).toBe("select_order");
  });
});

describe("classify_intent", () => {
  it("writes intent, confidence and route into the state", async () => {
    mocks.classify.mockResolvedValue({
      intent: "refund_return",
      confidence: 0.83,
    });
    const out = await classifyIntent(
      state({
        messages: [new HumanMessage("can this be returned")],
        resolvedQuery: "can the bluetooth headset still be returned",
      }),
    );
    expect(out.intent).toBe("refund_return");
    expect(out.intentConfidence).toBe(0.83);
    expect(out.route).toBe("refund_flow");
    expect(out.trace).toEqual({
      intent: "refund_return",
      intent_confidence: 0.83,
      route: "refund_flow",
    });
  });
});

describe("resolve_reference", () => {
  it("passes a complete question through", async () => {
    mocks.corefResolve.mockImplementation((q: string) => Promise.resolve(q));
    const out = await resolveReference(
      state({ messages: [new HumanMessage("how long is the warranty")] }),
    );
    expect(out.resolvedQuery).toBe("how long is the warranty");
    expect(out.trace).toEqual({ coref: "passthrough" });
  });

  it("rewrites a partial question using history", async () => {
    mocks.corefResolve.mockResolvedValue("can the headset still be returned");
    const out = await resolveReference(
      state({
        messages: [
          new HumanMessage("when does the headset arrive"),
          new AIMessage("tomorrow"),
          new HumanMessage("can it be returned"),
        ],
      }),
    );
    expect(out.resolvedQuery).toBe("can the headset still be returned");
    expect(out.trace).toEqual({ coref: "rewrite" });
  });
});

describe("retrieve_knowledge (forced RAG gate)", () => {
  it("builds numbered evidence when the evidence is strong", async () => {
    mocks.understand.mockResolvedValue({
      standard: "return policy",
      expanded: [],
    });
    mocks.searchKnowledge.mockResolvedValue([hit(1, 0.9)]);
    mocks.checkSufficient.mockResolvedValue({ useful: true, reason: "" });
    const out = await retrieveKnowledge(
      state({ messages: [new HumanMessage("what is the return policy")] }),
    );
    expect(out.evidenceStrong).toBe(true);
    expect(out.evidence).toContain("[1]");
    expect(out.citations?.[0]?.n).toBe(1);
    expect(out.trace).toMatchObject({ forced_rag: true });
    expect(out.retrievedSnapshot).toHaveLength(1);
  });

  it("blocks below the confidence threshold with retrieval_low_conf", async () => {
    mocks.understand.mockResolvedValue({
      standard: "delete account",
      expanded: [],
    });
    mocks.searchKnowledge.mockResolvedValue([]);
    const out = await retrieveKnowledge(
      state({ messages: [new HumanMessage("how do I delete my account")] }),
    );
    expect(out.evidenceStrong).toBe(false);
    expect(out.fallbackSource).toBe("retrieval_low_conf");
    expect(out.trace).toMatchObject({ forced_rag: true });
    expect(out.retrievedSnapshot).toEqual([]);
  });

  it("labels a self-check failure as self_check but keeps the snapshot", async () => {
    const saved = settings.evidenceConfidenceThreshold;
    settings.evidenceConfidenceThreshold = 0.3;
    try {
      mocks.understand.mockResolvedValue({ standard: "q", expanded: [] });
      mocks.searchKnowledge.mockResolvedValue([
        hit(1, 0.9),
        hit(2, 0.3),
        hit(3, 0.3),
      ]);
      mocks.checkSufficient.mockResolvedValue({
        useful: false,
        reason: "missing key info",
      });
      const out = await retrieveKnowledge(
        state({ messages: [new HumanMessage("can the cat bed be washed")] }),
      );
      expect(out.evidenceStrong).toBe(false);
      expect(out.fallbackSource).toBe("self_check");
      expect(out.retrievedSnapshot?.length ?? 0).toBeGreaterThan(0);
      expect(out.trace).toMatchObject({ self_check: "missing key info" });
    } finally {
      settings.evidenceConfidenceThreshold = saved;
    }
  });
});

describe("confidence_check", () => {
  it("traces the gate decision", () => {
    expect(confidenceCheck(state({ evidenceStrong: true })).trace).toEqual({
      confidence: "strong",
    });
    expect(confidenceCheck(state({ evidenceStrong: false })).trace).toEqual({
      confidence: "weak",
    });
  });
});

describe("retrieve_policy", () => {
  it("expands queries, dedups by chunk id keeping the best score", async () => {
    mocks.expandQueries.mockResolvedValue([
      "return policy",
      "no-reason return",
      "return window",
    ]);
    mocks.searchKnowledge.mockImplementation((q: string) => {
      if (q === "return policy") {
        return Promise.resolve([hit(1, 0.7)]);
      }
      if (q === "no-reason return") {
        return Promise.resolve([hit(1, 0.9), hit(2, 0.6)]);
      }
      return Promise.resolve([]);
    });
    const out = await retrievePolicy(
      state({
        resolvedQuery: "can this order be returned",
        orderData: { status: "delivered" },
      }),
    );
    expect(out.citations).toHaveLength(2);
    expect(out.citations?.map((c) => c.id)).toEqual([1, 2]);
    expect(out.evidence).toContain("[1]");
    expect(out.evidence).toContain("[2]");
    expect(out.trace).toMatchObject({
      retrieve_policy: {
        queries: ["return policy", "no-reason return", "return window"],
        hits: 2,
      },
    });
  });
});

describe("agent_messages context assembly", () => {
  it("injects evidence + order data after the user message on refund_flow, never into system", () => {
    const msgs = agentMessages(
      state({
        route: "refund_flow",
        orderData: {
          order_id: "1001",
          status: "delivered",
          product: "Cat food 5kg",
        },
        evidence: "[1] returns: 7-day no reason",
        messages: [new HumanMessage("can this order be returned")],
      }),
    );
    expect(msgs[0]).toBeInstanceOf(SystemMessage);
    const system = contentText(msgs[0]?.content);
    expect(system).not.toContain("7-day no reason");
    expect(system).not.toContain("Cat food 5kg");
    // turn material sits right after the user message (prefix-cache friendly)
    const userIdx = msgs.findIndex((m) => HumanMessage.isInstance(m));
    const ctx = msgs[userIdx + 1];
    expect(ctx).toBeDefined();
    const text = contentText(ctx?.content);
    expect(text).toContain("7-day no reason");
    expect(text).toContain("Cat food 5kg");
    expect(text).toContain("submit_refund"); // REFUND_JUDGE_HINT
    // order matters: the judge hint assumes the evidence was already given
    expect(text.indexOf("7-day no reason")).toBeLessThan(
      text.indexOf("submit_refund"),
    );
  });

  it("still injects evidence on the knowledge path", () => {
    const msgs = agentMessages(
      state({
        route: "knowledge",
        evidence: "[1] shipping fee: free over 99",
        messages: [new HumanMessage("how much is shipping")],
      }),
    );
    expect(contentText(msgs[0]?.content)).not.toContain("free over 99");
    expect(contentText(msgs.at(-1)?.content)).toContain("free over 99");
  });

  it("appends the summary ahead of the evidence", () => {
    const msgs = agentMessages(
      state({
        summary: "User asked about order 1001 earlier.",
        route: "knowledge",
        evidence: "[1] x: y",
        messages: [new HumanMessage("and the fee?")],
      }),
    );
    const ctx = contentText(msgs[2]?.content);
    expect(ctx.indexOf("User asked about order 1001 earlier.")).toBeLessThan(
      ctx.indexOf("[1] x: y"),
    );
  });
});

const ticketSpec = {
  name: "create_ticket",
  description: "create a ticket",
  jsonSchema: {
    type: "object",
    properties: {
      description: { type: "string" },
      ticket_type: { type: "string" },
    },
    required: ["description", "ticket_type"],
  },
  invoke: () => Promise.resolve({}),
  permission: "write",
  source: "builtin",
  mcpServer: null,
  timeout: null,
  maxRetries: null,
  injectConversation: true,
  injectUserId: false,
  formatResult: null,
};

describe("agent_tools", () => {
  beforeEach(() => {
    mocks.getAllSpecs.mockResolvedValue([ticketSpec]);
  });

  it("intercepts submit_refund into a front-end form for an owned order", async () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "r1",
          name: "submit_refund",
          args: { order_id: "1001", reason: null },
          type: "tool_call",
        },
      ],
    });
    const out = await agentTools(
      state({ messages: [ai], userId: "u1", conversationId: 9 }),
    );
    expect(out.suggestedActions).toEqual([
      { type: "refund_form", draft: { order_id: "1001", reason: null } },
    ]);
    const tm = toolMessageOf(out);
    expect(tm.name).toBe("submit_refund");
    expect(mocks.executeToolCall).not.toHaveBeenCalled();
  });

  it("refuses submit_refund for a foreign order and offers the picker", async () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "r2",
          name: "submit_refund",
          args: { order_id: "888888", reason: null },
          type: "tool_call",
        },
      ],
    });
    const out = await agentTools(
      state({ messages: [ai], userId: "u1", conversationId: 9 }),
    );
    const tm = toolMessageOf(out);
    expect(tm.status).toBe("error");
    const actions = out.suggestedActions ?? [];
    expect(actions.some((a) => a.type === "select_order")).toBe(true);
  });

  it("runs an ordinary tool call through the engine", async () => {
    mocks.executeToolCall.mockResolvedValue({
      toolMessage: new ToolMessage({
        content: "ok",
        tool_call_id: "c1",
        name: "query_order",
      }),
    });
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "c1",
          name: "query_order",
          args: { order_id: "1001" },
          type: "tool_call",
        },
      ],
    });
    const out = await agentTools(
      state({ messages: [ai], userId: "u1", conversationId: 9 }),
    );
    expect(mocks.executeToolCall).toHaveBeenCalledTimes(1);
    expect(toolMessageOf(out).content).toBe("ok");
  });
});

describe("create_ticket confirmation flow (minimal compiled graph)", () => {
  function buildToolsGraph() {
    const builder = new StateGraph(ConversationState)
      .addNode("agent_tools", agentTools)
      .addEdge(START, "agent_tools")
      .addEdge("agent_tools", END);
    return builder.compile({ checkpointer: new MemorySaver() });
  }

  const aiWithTicket = (): AIMessage =>
    new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "t1",
          name: "create_ticket",
          args: { description: "broken on arrival", ticket_type: "complaint" },
          type: "tool_call",
        },
      ],
    });

  function engineOpts(callIndex: number): {
    confirmed?: boolean | undefined;
    denyNote?: string | undefined;
  } {
    const call: unknown[] = mocks.executeToolCall.mock.calls[callIndex] ?? [];
    return z
      .object({
        confirmed: z.boolean().optional(),
        denyNote: z.string().optional(),
      })
      .parse(call[3]);
  }

  it("interrupts with the preview card, then executes on confirm", async () => {
    mocks.getAllSpecs.mockResolvedValue([ticketSpec]);
    mocks.executeToolCall.mockResolvedValue({
      toolMessage: new ToolMessage({
        content: "ticket created",
        tool_call_id: "t1",
        name: "create_ticket",
      }),
    });
    const graph = buildToolsGraph();
    const config = { configurable: { thread_id: "t-ticket" } };
    const out = await graph.invoke(
      {
        ...state(),
        messages: [aiWithTicket()],
        conversationId: 4,
        userId: "u1",
      },
      config,
    );
    const parsed = interruptSchema.parse(out);
    const value = parsed.__interrupt__[0]?.value;
    expect(value?.type).toBe("confirm_ticket");
    expect(value?.preview).toEqual({
      ticket_type: "complaint",
      description: "broken on arrival",
    });

    const resumed = await graph.invoke(
      new Command({ resume: { confirmed: true } }),
      config,
    );
    expect(mocks.executeToolCall).toHaveBeenCalledTimes(1);
    expect(engineOpts(0).confirmed).toBe(true);
    expect(toolMessageOf(resumed).content).toBe("ticket created");
  });

  it("denies execution with a note when the user cancels", async () => {
    mocks.getAllSpecs.mockResolvedValue([ticketSpec]);
    mocks.executeToolCall.mockResolvedValue({
      toolMessage: new ToolMessage({
        content: "denied",
        tool_call_id: "t1",
        name: "create_ticket",
        status: "error",
      }),
    });
    const graph = buildToolsGraph();
    const config = { configurable: { thread_id: "t-ticket-cancel" } };
    await graph.invoke(
      {
        ...state(),
        messages: [aiWithTicket()],
        conversationId: 5,
        userId: "u1",
      },
      config,
    );
    await graph.invoke(new Command({ resume: { confirmed: false } }), config);
    const opts = engineOpts(0);
    expect(opts.confirmed).toBe(false);
    expect(opts.denyNote).toContain("cancel");
  });
});

describe("log_node", () => {
  it("persists the assistant answer for audit", async () => {
    await logNode(
      state({ conversationId: 12, answer: "here you go", intent: "order" }),
    );
    expect(mocks.appendMessage).toHaveBeenCalledWith(12, "assistant", {
      content: "here you go",
    });
  });

  it("stores null when there is no answer text", async () => {
    await logNode(state({ conversationId: 12 }));
    expect(mocks.appendMessage).toHaveBeenCalledWith(12, "assistant", {
      content: null,
    });
  });
});
