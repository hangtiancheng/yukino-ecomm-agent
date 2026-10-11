import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import { buildGraph } from "#/graph/build.ts";

const EXPECTED_NODES = [
  "resolve_reference",
  "classify_intent",
  "retrieve_knowledge",
  "confidence_check",
  "main_agent",
  "agent_tools",
  "complaint_reply",
  "script_reply",
  "fallback_reply",
  "fetch_order",
  "retrieve_policy",
  "log",
];

describe("graph build", () => {
  it("contains all workflow nodes", async () => {
    const graph = buildGraph();
    const names = Object.keys((await graph.getGraphAsync()).nodes);
    for (const n of EXPECTED_NODES) {
      expect(names, `missing node ${n}`).toContain(n);
    }
  });

  it("wires the intent fan-out and the ReAct loop", async () => {
    const graph = buildGraph();
    const drawable = await graph.getGraphAsync();
    const edges = drawable.edges.map(
      (e) => `${e.source}->${e.target}${e.conditional ? "?" : ""}`,
    );
    // skeleton: START -> resolve_reference -> classify_intent, then five outlets
    expect(edges).toContain("__start__->resolve_reference");
    expect(edges).toContain("resolve_reference->classify_intent");
    for (const target of [
      "complaint_reply",
      "script_reply",
      "retrieve_knowledge",
      "fetch_order",
      "main_agent",
    ]) {
      expect(
        edges.some((e) => e === `classify_intent->${target}?`),
        `missing conditional edge classify_intent->${target}`,
      ).toBe(true);
    }
    // refund sub-flow: fetch_order -> retrieve_policy -> main_agent
    expect(edges).toContain("fetch_order->retrieve_policy");
    expect(edges).toContain("retrieve_policy->main_agent");
    // knowledge path: retrieve -> confidence gate -> strong/weak
    expect(edges).toContain("retrieve_knowledge->confidence_check");
    expect(edges).toContain("confidence_check->main_agent?");
    expect(edges).toContain("confidence_check->fallback_reply?");
    // ReAct loop
    expect(edges).toContain("main_agent->agent_tools?");
    expect(edges).toContain("main_agent->log?");
    expect(edges).toContain("agent_tools->main_agent");
    // deterministic exits converge on log -> END
    for (const src of ["complaint_reply", "script_reply", "fallback_reply"]) {
      expect(edges).toContain(`${src}->log`);
    }
    expect(edges).toContain("log->__end__");
  });

  it("compiles with a checkpointer", () => {
    expect(buildGraph(new MemorySaver())).toBeDefined();
  });
});
