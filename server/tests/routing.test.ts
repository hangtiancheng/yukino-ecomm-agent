import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { settings } from "#/config.ts";
import {
  INTENT_TO_ROUTE,
  confidenceGate,
  routeByIntent,
  shouldContinue,
} from "#/graph/routing.ts";
import type { GraphState } from "#/graph/state.ts";

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

describe("route_by_intent", () => {
  const cases: [string, string][] = [
    ["complaint", "escalate"],
    ["chitchat", "fallback_script"],
    ["other", "fallback_script"],
    ["product_inquiry", "knowledge"],
    ["refund_return", "refund_flow"],
    ["after_sales", "refund_flow"],
    ["human_agent", "business"],
    ["logistics", "business"],
    ["order", "business"],
  ];

  it.each(cases)("routes %s to %s", (intent, expectRoute) => {
    expect(routeByIntent(state({ intent }))).toBe(expectRoute);
  });

  it("defaults unknown intents to business", () => {
    expect(routeByIntent(state({ intent: "martian" }))).toBe("business");
    expect(routeByIntent(state())).toBe("business");
  });

  it("covers all nine intent classes", () => {
    expect(new Set(Object.keys(INTENT_TO_ROUTE))).toEqual(
      new Set([
        "complaint",
        "chitchat",
        "other",
        "product_inquiry",
        "refund_return",
        "after_sales",
        "human_agent",
        "logistics",
        "order",
      ]),
    );
  });
});

describe("confidence_gate", () => {
  it("passes strong evidence and falls back on weak", () => {
    expect(confidenceGate(state({ evidenceStrong: true }))).toBe("strong");
    expect(confidenceGate(state({ evidenceStrong: false }))).toBe("weak");
    expect(confidenceGate(state())).toBe("weak");
  });
});

describe("should_continue", () => {
  it("stops when there are no tool calls", () => {
    expect(
      shouldContinue(state({ messages: [new AIMessage("done")], steps: 1 })),
    ).toBe("stop");
  });

  it("continues on tool calls", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "query_order", args: {}, id: "1", type: "tool_call" },
      ],
    });
    expect(shouldContinue(state({ messages: [ai], steps: 1 }))).toBe(
      "continue",
    );
  });

  it("stops at the step cap", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "query_order", args: {}, id: "1", type: "tool_call" },
      ],
    });
    expect(
      shouldContinue(state({ messages: [ai], steps: settings.maxAgentSteps })),
    ).toBe("stop");
  });

  it("does not use token spend as a stop condition", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { name: "query_order", args: {}, id: "1", type: "tool_call" },
      ],
    });
    expect(
      shouldContinue(
        state({ messages: [ai], steps: 1, tokensUsed: 10_000_000 }),
      ),
    ).toBe("continue");
  });
});
