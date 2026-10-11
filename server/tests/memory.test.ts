import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  buildWindow,
  charsToTokens,
  compressReply,
  compressToolResult,
  contentToString,
  countTokens,
  layerTokens,
  nextLayer1From,
  summarySystem,
  toLayer2,
  tokensToChars,
} from "#/core/memory.ts";

describe("memory", () => {
  it("converts between chars and tokens with the calibrated ratio", () => {
    expect(charsToTokens(120)).toBe(30);
    expect(tokensToChars(30)).toBe(120);
  });

  it("counts tokens monotonically", () => {
    const one = countTokens([
      new HumanMessage("Hi, who pays the return shipping fee"),
    ]);
    const two = countTokens([
      new HumanMessage("Hi, who pays the return shipping fee"),
      new HumanMessage("Also, where is order 1001"),
    ]);
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
  });

  it("compresses long replies and large tool results only", () => {
    expect(compressReply("short")).toBe("short");
    expect(compressReply("x".repeat(200))).toContain("… (truncated)");
    expect(compressToolResult("query_order", "small result")).toBe(
      "small result",
    );
    expect(compressToolResult("query_faq", "x".repeat(2000))).toBe(
      "(Called query_faq; result omitted)",
    );
  });

  it("keeps tool_calls when rendering layer 2", () => {
    const ai = new AIMessage({
      content: "Let me look that up",
      tool_calls: [
        {
          name: "query_order",
          args: { order_id: "1001" },
          id: "call-1",
          type: "tool_call",
        },
      ],
    });
    const tool = new ToolMessage({
      content: "result",
      tool_call_id: "call-1",
      name: "query_order",
    });
    const rendered = toLayer2([ai, tool]);
    expect(rendered).toHaveLength(2);
    const renderedAi = rendered[0];
    expect(renderedAi).toBeInstanceOf(AIMessage);
    if (renderedAi instanceof AIMessage) {
      expect(renderedAi.tool_calls?.[0]?.id).toBe("call-1");
    }
  });

  it("wraps the summary as a system message", () => {
    expect(summarySystem(null)).toBeNull();
    expect(
      summarySystem("The user asked about shipping fees")?.content,
    ).toContain("Summary of earlier conversation");
  });

  it("slices the window after the summary anchor", () => {
    const messages = [
      new HumanMessage({ content: "old question", id: "db-1" }),
      new AIMessage({ content: "old answer" }),
      new HumanMessage({ content: "new question", id: "db-2" }),
      new AIMessage({ content: "new answer" }),
    ];
    const window = buildWindow(messages, 1, 0, 100_000);
    expect(window).toHaveLength(2);
    expect(contentToString(window[0].content)).toBe("new question");
  });
});

function dialogue(
  turns: number,
  replyChars = 200,
): (AIMessage | HumanMessage)[] {
  const msgs: (AIMessage | HumanMessage)[] = [];
  for (let i = 1; i <= turns; i += 1) {
    msgs.push(
      new HumanMessage({
        content: `question of turn ${i}`,
        id: `db-${i * 2 - 1}`,
      }),
    );
    msgs.push(new AIMessage({ content: "x".repeat(replyChars) }));
  }
  return msgs;
}

describe("layered window (ch07)", () => {
  it("never compresses user text", () => {
    const msgs = [
      new HumanMessage(
        "that pair of running shoes I asked about, order 202603150088",
      ),
    ];
    expect(contentToString(toLayer2(msgs)[0].content)).toBe(
      contentToString(msgs[0].content),
    );
  });

  it("layer 2 rendering is idempotent", () => {
    // Degradation happens in batches; re-rendering must be byte-stable or the
    // prompt-cache prefix keeps changing.
    const msgs = [
      ...dialogue(3),
      new ToolMessage({
        content: "e".repeat(4000),
        tool_call_id: "t1",
        name: "query_faq",
      }),
    ];
    const once = toLayer2(msgs);
    const twice = toLayer2(once);
    expect(once.map((m) => contentToString(m.content))).toEqual(
      twice.map((m) => contentToString(m.content)),
    );
  });

  it("keeps message ids (window anchors) through compression", () => {
    const msgs = dialogue(2);
    const rendered = toLayer2(msgs);
    rendered.forEach((m, i) => {
      expect(m.id).toBe(msgs[i].id);
    });
  });

  it("without anchors the window is a single layer", () => {
    const msgs = dialogue(3);
    expect(buildWindow(msgs, 0, 0, 10_000)).toEqual(msgs);
  });

  it("splits half-compressed layer 2 from verbatim layer 1 at the anchor", () => {
    const msgs = dialogue(6, 400);
    const out = buildWindow(msgs, 0, 5, 100_000);
    expect(contentToString(out[1].content)).toContain("truncated"); // turn-1 reply compressed
    expect(contentToString(out.at(-1)?.content ?? "")).not.toContain(
      "truncated",
    ); // latest intact
  });

  it("layer tokens split at the anchor and compression shrinks the total", () => {
    const msgs = dialogue(6, 400);
    const [l2, l1] = layerTokens(msgs, 0, 5);
    expect(l2).toBeGreaterThan(0);
    expect(l1).toBeGreaterThan(0);
    expect(l2 + l1).toBeLessThan(countTokens(msgs));
  });

  it("a tighter layer-1 budget moves the boundary later", () => {
    const msgs = dialogue(10, 400);
    const tight = nextLayer1From(msgs, 0, 500);
    const loose = nextLayer1From(msgs, 0, 5_000);
    expect(tight).toBeGreaterThan(loose);
  });

  it("returns 0 when the budget is ample (no degradation)", () => {
    expect(nextLayer1From(dialogue(3), 0, 1_000_000)).toBe(0);
  });
});
