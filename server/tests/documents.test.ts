import { describe, expect, it } from "vitest";

import { buildChunks, isKey } from "#/kb/documents.ts";

describe("build_chunks", () => {
  it("maps heading and parent path for a policy section", async () => {
    const md =
      "# After-sales policy\n\n## Shipping fee\n\nFree shipping on orders of 99 yuan or more; 10 yuan below that. Remote areas cost extra.";
    const chunks = await buildChunks(md, "policy");
    const c = chunks.find((x) => x.questions === "Shipping fee");
    expect(c).toBeDefined();
    expect(c?.category).toBe("After-sales policy");
    expect(c?.sectionPath).toBe("After-sales policy / Shipping fee");
    expect(c?.answer).toContain("99 yuan");
    expect(c?.contentType).toBe("policy");
    expect(c?.isKeyClause).toBe(1); // "shipping fee" is a key term
  });

  it("splits a big table by rows, repeating the header", async () => {
    const rows = Array.from(
      { length: 14 },
      (_, i) => `| Product${i + 1} | ${i + 1} |`,
    ).join("\n");
    const md = `# Price list\n\n## Prices\n\n| Product | Price |\n| --- | --- |\n${rows}`;
    const chunks = await buildChunks(md, "manual", 400, 60, 5);
    const price = chunks.filter((c) => c.questions === "Prices");
    expect(price.length).toBeGreaterThanOrEqual(2);
    for (const c of price) {
      expect(c.answer.startsWith("| Product | Price |")).toBe(true);
    }
  });

  it("falls back to the content type when there is no heading", async () => {
    const chunks = await buildChunks("plain body text without headings", "faq");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].category).toBe("faq");
    expect(chunks[0].questions).toBe("faq");
  });

  it("skips empty sections", async () => {
    const chunks = await buildChunks("# A\n\n## B\n\nbody.", "faq");
    expect(chunks.every((c) => c.answer.trim().length > 0)).toBe(true);
  });
});

describe("is_key", () => {
  it("flags key-clause terms in the title or the first 40 chars", () => {
    expect(isKey("Refund policy", "whatever")).toBe(1);
    expect(isKey("Section", "the warranty period is 12 months")).toBe(1);
    expect(isKey("Section", "totally unrelated body")).toBe(0);
  });
});
