import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DEMO_ORDER_IDS,
  listUserOrders,
  orderSnapshot,
  ownsOrder,
  productSnapshot,
} from "#/tools/business.ts";
import { getBuiltinSpec } from "#/tools/registry.ts";

const USER = "u-alice";
const OTHER = "u-bob";

/** A private order of this user (skipping the demo orders everyone has). */
function ownOrder(uid: string): string {
  const demo: string[] = [...DEMO_ORDER_IDS];
  const orders = listUserOrders(uid).filter((o) => !demo.includes(o.order_id));
  return orders[0].order_id;
}

describe("order ownership", () => {
  it("only accepts orders that belong to the user", () => {
    const mine = ownOrder(USER);
    expect(ownsOrder(USER, mine)).toBe(true);
    expect(ownsOrder(OTHER, mine)).toBe(false);
  });

  it("never passes an empty identity", () => {
    expect(ownsOrder("", ownOrder(USER))).toBe(false);
    expect(ownsOrder(USER, "")).toBe(false);
  });

  it("demo orders exist for every account", () => {
    for (const uid of [USER, OTHER, "u-anyone"]) {
      for (const demo of DEMO_ORDER_IDS) {
        expect(ownsOrder(uid, demo)).toBe(true);
      }
    }
    expect(ownsOrder(USER, ownOrder(OTHER))).toBe(false);
  });

  it("lists orders deterministically per user", () => {
    const a = listUserOrders("u-42");
    const b = listUserOrders("u-42");
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(2);
    const snap = orderSnapshot(a[0].order_id);
    expect(snap.order_id).toBe(a[0].order_id);
    expect(snap.product).toBe(a[0].product);
  });
});

describe("query_order / submit_refund ownership gate", () => {
  it("returns the full snapshot for an owned order", async () => {
    const spec = await getBuiltinSpec("query_order");
    expect(spec).not.toBeNull();
    const mine = ownOrder(USER);
    const out = z
      .looseObject({ order_id: z.string(), tracking_no: z.string() })
      .parse(await spec?.invoke({ order_id: mine, user_id: USER }));
    expect(out.order_id).toBe(mine);
    expect(out).toHaveProperty("tracking_no");
  });

  it("refuses another user's order without leaking any field", async () => {
    const spec = await getBuiltinSpec("query_order");
    const out = z
      .record(z.string(), z.unknown())
      .parse(await spec?.invoke({ order_id: ownOrder(OTHER), user_id: USER }));
    expect(out.code).toBe("order_not_owned");
    for (const leaked of [
      "amount",
      "product",
      "tracking_no",
      "status",
      "created_at",
    ]) {
      expect(out).not.toHaveProperty(leaked);
    }
  });

  it("answers a nonexistent order exactly like a foreign one (no enumeration oracle)", async () => {
    const spec = await getBuiltinSpec("query_order");
    const errorSchema = z.object({ error: z.string(), code: z.string() });
    const foreign = errorSchema.parse(
      await spec?.invoke({ order_id: ownOrder(OTHER), user_id: USER }),
    );
    const nobody = errorSchema.parse(
      await spec?.invoke({ order_id: "999999", user_id: USER }),
    );
    expect(foreign.error).toBe(nobody.error);
    expect(foreign.code).toBe("order_not_owned");
    expect(nobody.code).toBe("order_not_owned");
  });

  it("submit_refund goes through the same gate", async () => {
    const spec = await getBuiltinSpec("submit_refund");
    const out = z.object({ code: z.string() }).parse(
      await spec?.invoke({
        order_id: ownOrder(OTHER),
        reason: "no longer wanted",
        user_id: USER,
      }),
    );
    expect(out.code).toBe("order_not_owned");
  });

  it("rejects reads when the injected identity is missing", async () => {
    const spec = await getBuiltinSpec("query_order");
    const out = z
      .object({ code: z.string() })
      .parse(await spec?.invoke({ order_id: ownOrder(USER), user_id: "" }));
    expect(out.code).toBe("order_not_owned");
  });
});

describe("product snapshot", () => {
  it("is deterministic per product name", () => {
    expect(productSnapshot("cat food")).toEqual(productSnapshot("cat food"));
  });
});
