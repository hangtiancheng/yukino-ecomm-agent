import { describe, expect, it, vi } from "vitest";

import { settings } from "#/config.ts";
import type { KnowledgeHit } from "#/kb/store.ts";
import { evaluateHits, queryFaq } from "#/tools/builtin/faq.ts";

const mocks = vi.hoisted(() => ({
  understand: vi.fn(),
  searchKnowledge: vi.fn(),
  checkSufficient: vi.fn(),
}));

vi.mock("#/core/query-understanding.ts", () => ({
  understand: mocks.understand,
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

function hit(id: number, score: number): KnowledgeHit {
  return {
    id,
    score,
    question: `q${id}`,
    answer: `a${id}`,
    section_path: `path ${id}`,
    content_type: "faq",
    category: "shipping",
    rerank_score: score,
  };
}

describe("query_faq gates", () => {
  it("answers with numbered citations when the evidence is strong", async () => {
    mocks.understand.mockResolvedValue({
      standard: "shipping fee",
      expanded: ["postage"],
    });
    mocks.searchKnowledge.mockResolvedValue([hit(1, 0.9), hit(2, 0.6)]);
    mocks.checkSufficient.mockResolvedValue({ useful: true, reason: "enough" });

    const out = await queryFaq({ keyword: "how much is postage" });
    expect(out.sufficient).toBe(true);
    expect(out.citations[0]?.n).toBe(1);
    expect(out.citations[0]?.section_path).toBe("path 1");
    expect(out.evidence).toContain("[1]");
    // synonym expansion only feeds the BM25 text, not the dense query
    const call = mocks.searchKnowledge.mock.calls[0];
    expect(call?.[0]).toBe("shipping fee");
    expect(call?.[1]).toMatchObject({ bm25Text: "shipping fee postage" });
  });

  it("refuses with retrieval_low_conf when nothing is recalled", async () => {
    mocks.understand.mockResolvedValue({
      standard: "buy a mars rover",
      expanded: [],
    });
    mocks.searchKnowledge.mockResolvedValue([]);

    const out = await queryFaq({ keyword: "buy a mars rover" });
    expect(out.sufficient).toBe(false);
    expect(out.source).toBe("retrieval_low_conf");
    expect(mocks.checkSufficient).not.toHaveBeenCalled();
  });

  it("refuses below the rerank floor", async () => {
    mocks.understand.mockResolvedValue({ standard: "q", expanded: [] });
    mocks.searchKnowledge.mockResolvedValue([
      hit(1, settings.rerankMinScore - 0.1),
    ]);

    const out = await queryFaq({ keyword: "q" });
    expect(out.sufficient).toBe(false);
    expect(out.source).toBe("retrieval_low_conf");
  });

  it("falls back to unfiltered search when the guessed category misses", async () => {
    mocks.understand.mockResolvedValue({ standard: "postage", expanded: [] });
    mocks.searchKnowledge.mockImplementation(
      (_q: string, opts?: { category?: string | null }) => {
        if (opts?.category) {
          return Promise.resolve([]); // wrong guessed category filters everything out
        }
        return Promise.resolve([hit(1, 0.9)]);
      },
    );
    mocks.checkSufficient.mockResolvedValue({ useful: true, reason: "enough" });

    const out = await queryFaq({
      keyword: "postage",
      category: "a category that does not exist",
    });
    expect(out.sufficient).toBe(true);
    expect(out.citations[0]?.id).toBe(1);
    expect(mocks.searchKnowledge).toHaveBeenCalledTimes(2);
  });

  it("honours the semantic gate when the evidence misses the point", async () => {
    mocks.understand.mockResolvedValue({
      standard: "does the Pro model auto-scoop",
      expanded: [],
    });
    mocks.searchKnowledge.mockResolvedValue([hit(1, 0.8)]);
    mocks.checkSufficient.mockResolvedValue({
      useful: false,
      reason: "asked about a model, evidence only covers shipping",
    });

    const out = await queryFaq({ keyword: "does the Pro model auto-scoop" });
    expect(out.sufficient).toBe(false);
    expect(out.source).toBe("self_check");
    expect(out.reason).toContain("model");
  });
});

describe("evaluate_hits", () => {
  it("arranges head-tail and numbers citations", async () => {
    mocks.checkSufficient.mockResolvedValue({ useful: true, reason: "" });
    const hits = [hit(1, 0.9), hit(2, 0.8), hit(3, 0.7)];
    const out = await evaluateHits("q", hits);
    expect(out.sufficient).toBe(true);
    // head-tail: most relevant first, second most relevant last
    expect(out.citations.map((c) => c.id)).toEqual([1, 3, 2]);
    expect(out.citations.map((c) => c.n)).toEqual([1, 2, 3]);
  });
});
