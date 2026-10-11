import { AIMessage } from "@langchain/core/messages";
import { RunnableLambda } from "@langchain/core/runnables";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as coref from "#/core/coref.ts";
import * as intent from "#/core/intent.ts";
import * as queryUnderstanding from "#/core/query-understanding.ts";
import * as selfcheck from "#/core/selfcheck.ts";

const mocks = vi.hoisted(() => ({
  structuredImpl: vi.fn<(...args: unknown[]) => unknown>(),
  modelImpl: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock("#/core/llm.ts", () => ({
  structured: (...args: unknown[]): unknown => mocks.structuredImpl(...args),
  getChatModel: (...args: unknown[]): unknown => mocks.modelImpl(...args),
}));

function runnable(result: unknown): unknown {
  return RunnableLambda.from(async () => {
    await Promise.resolve();
    return result;
  });
}

function failing(): unknown {
  return RunnableLambda.from(async () => {
    await Promise.resolve();
    throw new Error("upstream down");
  });
}

beforeEach(() => {
  mocks.structuredImpl.mockReset();
  mocks.modelImpl.mockReset();
});

describe("selfcheck fail-closed semantics", () => {
  it("passes through a useful verdict", async () => {
    mocks.structuredImpl.mockReturnValue(
      runnable({ useful: true, reason: "evidence covers it" }),
    );
    const out = await selfcheck.checkSufficient("q", ["e1"]);
    expect(out).toEqual({ useful: true, reason: "evidence covers it" });
  });

  it("treats an upstream failure as insufficient evidence", async () => {
    // The gate's job is to stop answers the evidence cannot support; when the
    // gate itself is down there is no way to know, so it must fail closed.
    mocks.structuredImpl.mockReturnValue(failing());
    const out = await selfcheck.checkSufficient("q", ["e1"]);
    expect(out.useful).toBe(false);
    expect(out.reason).toBeTruthy();
  });
});

describe("intent classification fallback", () => {
  it("returns the classified intent with confidence", async () => {
    mocks.structuredImpl.mockReturnValue(
      runnable({ intent: "logistics", confidence: 0.83 }),
    );
    const out = await intent.classify("where is my order");
    expect(out).toEqual({ intent: "logistics", confidence: 0.83 });
  });

  it("falls back to other/0 when the upstream fails", async () => {
    mocks.structuredImpl.mockReturnValue(failing());
    const out = await intent.classify("where is my order");
    expect(out).toEqual({ intent: "other", confidence: 0 });
  });
});

describe("coref rewrite fallback", () => {
  it("returns the rewritten query", async () => {
    mocks.modelImpl.mockReturnValue(
      RunnableLambda.from(async () => {
        await Promise.resolve();
        return new AIMessage("Can order 1001 be returned");
      }),
    );
    expect(await coref.resolve("can it be returned", "order 1001 ...")).toBe(
      "Can order 1001 be returned",
    );
  });

  it("keeps the original when the model answers empty", async () => {
    mocks.modelImpl.mockReturnValue(
      RunnableLambda.from(async () => {
        await Promise.resolve();
        return new AIMessage("   ");
      }),
    );
    expect(await coref.resolve("original question")).toBe("original question");
  });

  it("keeps the original when the upstream fails", async () => {
    // Rewriting only improves retrieval; it must never take the request down.
    mocks.modelImpl.mockReturnValue(failing());
    expect(await coref.resolve("original question")).toBe("original question");
  });
});

describe("query understanding fallbacks", () => {
  it("returns the standard phrasing plus expansions", async () => {
    mocks.structuredImpl.mockReturnValue(
      runnable({ standard: "return policy", expanded: ["refund rules"] }),
    );
    const out = await queryUnderstanding.understand("can I return it");
    expect(out).toEqual({
      standard: "return policy",
      expanded: ["refund rules"],
    });
  });

  it("falls back to the raw query when rewriting fails", async () => {
    mocks.structuredImpl.mockReturnValue(failing());
    const out = await queryUnderstanding.understand("can I return it");
    expect(out).toEqual({ standard: "can I return it", expanded: [] });
  });

  it("expand_queries keeps at most three non-empty queries", async () => {
    mocks.structuredImpl.mockReturnValue(
      runnable({ queries: ["a", "", "  ", "b", "c", "d"] }),
    );
    const out = await queryUnderstanding.expandQueries("seed");
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("expand_queries falls back to the seed on failure or emptiness", async () => {
    mocks.structuredImpl.mockReturnValue(runnable({ queries: [] }));
    expect(await queryUnderstanding.expandQueries("seed")).toEqual(["seed"]);
    mocks.structuredImpl.mockReturnValue(failing());
    expect(await queryUnderstanding.expandQueries("seed")).toEqual(["seed"]);
  });
});
