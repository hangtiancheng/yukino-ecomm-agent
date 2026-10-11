import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { messagesStateReducer } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { ConversationState, mergeDict } from "#/graph/state.ts";

describe("merge_dict trace reducer", () => {
  it("accumulates keys, later writes win", () => {
    expect(mergeDict({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(mergeDict(null, { b: 2 })).toEqual({ b: 2 });
    expect(mergeDict({ a: 1 }, { a: 9 })).toEqual({ a: 9 });
  });

  it("treats null as the per-turn reset sentinel", () => {
    // The graph entry passes trace=null each turn to clear stale keys; merging
    // {} would keep the old trace (merge(old, {}) = old) and leak e.g.
    // retrieve_policy across turns.
    expect(mergeDict({ a: 1 }, null)).toEqual({});
  });
});

describe("messages reducer", () => {
  it("appends new messages", () => {
    const merged = messagesStateReducer(
      [new HumanMessage("hi")],
      [new AIMessage("yo")],
    );
    expect(merged.map((m) => m.content)).toEqual(["hi", "yo"]);
  });
});

describe("ConversationState channels", () => {
  it("declares every required state key", () => {
    const keys = Object.keys(ConversationState.spec);
    for (const k of [
      "messages",
      "userId",
      "conversationId",
      "intent",
      "route",
      "evidence",
      "citations",
      "evidenceStrong",
      "answer",
      "steps",
      "tokensUsed",
      "suggestedActions",
      "trace",
      "summary",
      "summaryUptoMsgId",
      "layer1FromMsgId",
      "resolvedQuery",
      "intentConfidence",
      "orderId",
      "orderData",
      "evidenceConfidence",
      "fallbackSource",
      "retrievedSnapshot",
    ]) {
      expect(keys).toContain(k);
    }
  });
});
