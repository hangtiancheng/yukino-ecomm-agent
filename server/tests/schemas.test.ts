import { describe, expect, it } from "vitest";

import {
  afterSalesTicketSchema,
  chatRequestSchema,
  createRefundRequestSchema,
  createTicketRequestSchema,
  extractRequestSchema,
  faithCaseStatusRequestSchema,
  normalizeOrderId,
  resumeRequestSchema,
  searchRequestSchema,
  stagingReviewRequestSchema,
} from "#/api/schemas.ts";

describe("chat/agent request schemas", () => {
  it("rejects an empty message", () => {
    expect(
      chatRequestSchema.safeParse({ user_id: "s1", message: "" }).success,
    ).toBe(false);
  });

  it("defaults conversation_id to null", () => {
    const parsed = chatRequestSchema.parse({ user_id: "s1", message: "hi" });
    expect(parsed.conversation_id).toBeNull();
  });
});

describe("extract schemas", () => {
  it("rejects empty text", () => {
    expect(extractRequestSchema.safeParse({ text: "" }).success).toBe(false);
  });

  it("accepts a null order id", () => {
    const t = afterSalesTicketSchema.parse({
      order_id: null,
      request_type: "refund",
      expected_solution: "full refund",
    });
    expect(t.order_id).toBeNull();
    expect(t.request_type).toBe("refund");
  });

  it("rejects an unknown request type", () => {
    expect(
      afterSalesTicketSchema.safeParse({
        order_id: null,
        request_type: "haggle",
        expected_solution: "x",
      }).success,
    ).toBe(false);
  });

  it("normalizes placeholder order ids to null", () => {
    for (const placeholder of ["null", "None", "无", " N/A ", ""]) {
      expect(normalizeOrderId(placeholder)).toBeNull();
    }
    expect(normalizeOrderId("MH20260701123")).toBe("MH20260701123");
    expect(normalizeOrderId(null)).toBeNull();
  });
});

describe("action schemas", () => {
  it("rejects an unknown ticket type", () => {
    expect(
      createTicketRequestSchema.safeParse({
        conversation_id: 5,
        description: "broken",
        ticket_type: "random",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown refund reason", () => {
    expect(
      createRefundRequestSchema.safeParse({
        conversation_id: 7,
        order_id: "1001",
        reason: "random",
      }).success,
    ).toBe(false);
  });

  it("resume defaults both channels to null", () => {
    const parsed = resumeRequestSchema.parse({ conversation_id: 3 });
    expect(parsed.order_id).toBeNull();
    expect(parsed.confirmed).toBeNull();
  });
});

describe("kb/rageval schemas", () => {
  it("staging review requires at least one id", () => {
    expect(stagingReviewRequestSchema.safeParse({ ids: [] }).success).toBe(
      false,
    );
  });

  it("search clamps strategy and top_k", () => {
    expect(
      searchRequestSchema.safeParse({ q: "x", strategy: "magic" }).success,
    ).toBe(false);
    expect(searchRequestSchema.safeParse({ q: "x", top_k: 99 }).success).toBe(
      false,
    );
    expect(searchRequestSchema.parse({ q: "x" }).strategy).toBe("vector");
  });

  it("faith-case status is an enum with an optional note", () => {
    expect(
      faithCaseStatusRequestSchema.safeParse({ status: "whatever" }).success,
    ).toBe(false);
    const parsed = faithCaseStatusRequestSchema.parse({ status: "resolved" });
    expect(parsed.resolution).toBeNull();
  });
});
