import { describe, expect, it } from "vitest";

import {
  applySentenceOverlap,
  isTableBlock,
  recursiveSplit,
  splitSections,
  splitTableRows,
} from "#/kb/chunking.ts";

describe("chunking", () => {
  it("splits markdown by header level and keeps the path in metadata", () => {
    const sections = splitSections(
      "# Returns Policy\n\n7-day no-reason returns.\n\n## How to Apply\n\nTap refund under My Orders.",
    );
    expect(sections).toHaveLength(2);
    expect(sections[0].metadata).toEqual({ h1: "Returns Policy" });
    expect(sections[0].pageContent).toBe("7-day no-reason returns.");
    expect(sections[1].metadata).toEqual({
      h1: "Returns Policy",
      h2: "How to Apply",
    });
    expect(sections[1].pageContent).toContain("Tap refund under My Orders");
  });

  it("detects markdown tables", () => {
    const table = "| Timeframe | Note |\n| --- | --- |\n| 7 days | No reason |";
    expect(isTableBlock(table)).toBe(true);
    expect(isTableBlock("A plain paragraph.")).toBe(false);
  });

  it("repeats the table header when splitting wide tables", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `| r${i} | v${i} |`).join(
      "\n",
    );
    const table = `| Column | Value |\n| --- | --- |\n${rows}`;
    const parts = splitTableRows(table, 2);
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part.split("\n")[0]).toContain("| Column |");
    }
  });

  it("keeps whole trailing sentences as overlap", () => {
    const out = applySentenceOverlap(
      ["First sentence. Second sentence.", "Third sentence."],
      6,
    );
    expect(out[1]).toBe("Second sentence.Third sentence.");
  });

  it("keeps a whole sentence even when it exceeds the overlap budget", () => {
    // Never start mid-sentence: an over-long single sentence is copied whole.
    const out = applySentenceOverlap(
      [
        "A very very long sentence without inner punctuation until the end.",
        "New chunk.",
      ],
      5,
    );
    expect(out[1]).toBe(
      "A very very long sentence without inner punctuation until the end.New chunk.",
    );
  });

  it("handles empty and single-chunk input", () => {
    expect(applySentenceOverlap([], 5)).toEqual([]);
    expect(applySentenceOverlap(["Only one chunk."], 5)).toEqual([
      "Only one chunk.",
    ]);
  });

  it("recursive split breaks oversized text under the chunk size", async () => {
    const text = Array.from({ length: 60 }, () => "sentence content.").join(
      " ",
    );
    const parts = await recursiveSplit(text, 50, 0);
    expect(parts.length).toBeGreaterThan(1);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(50);
  });

  it("a small table stays whole", () => {
    const table =
      "| Product | Price |\n| --- | --- |\n| A | 1 |\n| B | 2 |".replaceAll(
        "\\n",
        "\n",
      );
    expect(splitTableRows(table, 10)).toEqual([table]);
  });

  it("detects and splits a table preceded by prose", () => {
    const block =
      "Note: the table below lists timeframes.\n| Type | Limit |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n| C | 3 |".replaceAll(
        "\\n",
        "\n",
      );
    expect(isTableBlock(block)).toBe(true);
    const out = splitTableRows(block, 2);
    expect(out).toHaveLength(2);
    expect(out[0].startsWith("Note: the table below lists timeframes.")).toBe(
      true,
    );
    expect(out[0]).toContain("| Type | Limit |");
    expect(out[1]).toBe(
      "| Type | Limit |\n| --- | --- |\n| C | 3 |".replaceAll("\\n", "\n"),
    );
  });
});
