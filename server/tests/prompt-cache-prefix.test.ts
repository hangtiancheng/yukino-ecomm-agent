import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { AGENT_SYSTEM } from "#/core/prompts.ts";
import { agentMessages } from "#/graph/nodes.ts";
import type { GraphState } from "#/graph/state.ts";
import { contentText } from "#tests/helpers/json.ts";

function state(overrides: Partial<GraphState> = {}): GraphState {
  return {
    messages: [
      new HumanMessage({ content: "can this be returned", id: "db-1" }),
    ],
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

const ROUTES: GraphState["route"][] = [
  "knowledge",
  "business",
  "refund_flow",
  "complaint",
  "fallback_script",
];

describe("prompt-cache prefix stability", () => {
  it("the system message is always exactly the static AGENT_SYSTEM", () => {
    for (const route of ROUTES) {
      const msgs = agentMessages(
        state({
          route,
          evidence: "[1] volatile evidence",
          orderData: { order_id: "1001" },
          summary: "earlier talk",
        }),
      );
      expect(contentText(msgs[0]?.content)).toBe(AGENT_SYSTEM);
    }
  });

  it("the system prefix is byte-identical across all routes", () => {
    const prefixes = ROUTES.map((route) =>
      contentText(
        agentMessages(
          state({ route, evidence: "[1] x", orderData: { order_id: "1" } }),
        )[0]?.content,
      ),
    );
    expect(new Set(prefixes).size).toBe(1);
  });

  it("there is exactly one system message in the assembled prompt", () => {
    for (const route of ROUTES) {
      const msgs = agentMessages(
        state({
          route,
          evidence: "[1] volatile evidence",
          summary: "earlier talk",
          orderData: { order_id: "1001" },
        }),
      );
      const systems = msgs.filter((m) => m instanceof SystemMessage);
      expect(systems).toHaveLength(1);
    }
  });

  it("volatile payloads never land in any system message", () => {
    const msgs = agentMessages(
      state({
        route: "refund_flow",
        evidence: "[1] volatile evidence",
        summary: "earlier talk",
        orderData: { order_id: "1001", product: "Cat food 5kg" },
      }),
    );
    for (const m of msgs.filter((x) => x instanceof SystemMessage)) {
      const text = contentText(m.content);
      expect(text).not.toContain("volatile evidence");
      expect(text).not.toContain("earlier talk");
      expect(text).not.toContain("Cat food 5kg");
    }
  });

  it("step 1 prompt is a strict prefix of the step 2 prompt", () => {
    // Turn material is inserted after the last user message, so a ReAct
    // step-2 window [Sys, user, material, AI, Tool] still starts with the
    // step-1 window [Sys, user, material] — appending at the end would break
    // the shared prefix.
    const step1 = agentMessages(
      state({ route: "knowledge", evidence: "[1] evidence text" }),
    );
    const step2 = agentMessages(
      state({
        route: "knowledge",
        evidence: "[1] evidence text",
        messages: [
          new HumanMessage({ content: "can this be returned", id: "db-1" }),
        ],
      }),
    );
    const s1 = step1.map((m) => contentText(m.content));
    const s2 = step2.map((m) => contentText(m.content));
    expect(s2.slice(0, s1.length)).toEqual(s1);
  });

  it("turn context is not written back into the state", () => {
    const s = state({ route: "knowledge", evidence: "[1] evidence text" });
    agentMessages(s);
    expect(s.messages).toHaveLength(1); // no injected message leaked into state
  });
});
