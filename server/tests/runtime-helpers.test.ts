import { describe, expect, it } from "vitest";

import { dedupActions } from "#/graph/runtime.ts";

describe("dedup_actions", () => {
  it("keeps the first occurrence per action type", () => {
    const out = dedupActions([
      { type: "transfer_human" },
      { type: "create_ticket", draft: { description: "first" } },
      { type: "transfer_human" },
      { type: "create_ticket", draft: { description: "second" } },
    ]);
    expect(out).toEqual([
      { type: "transfer_human" },
      { type: "create_ticket", draft: { description: "first" } },
    ]);
  });

  it("handles an empty list", () => {
    expect(dedupActions([])).toEqual([]);
  });
});
