import { RunnableLambda } from "@langchain/core/runnables";
import type { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { readJson } from "#tests/helpers/json.ts";

const mocks = vi.hoisted(() => {
  const state: { result: unknown; fail: boolean } = {
    result: null,
    fail: false,
  };
  return { state };
});

vi.mock("#/core/llm.ts", () => ({
  structured: () =>
    RunnableLambda.from(async () => {
      await Promise.resolve();
      if (mocks.state.fail) {
        throw new Error("upstream down");
      }
      return mocks.state.result;
    }),
}));

let app: Hono;

beforeAll(async () => {
  vi.resetModules();
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

const ticketSchema = z.object({
  order_id: z.string().nullable(),
  request_type: z.string(),
  expected_solution: z.string(),
});

function post(text: string): Promise<Response> {
  return Promise.resolve(
    app.request("/api/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  );
}

describe("/api/extract", () => {
  it("returns the structured ticket", async () => {
    mocks.state.fail = false;
    mocks.state.result = {
      order_id: "MH20260701123",
      request_type: "refund",
      expected_solution: "arrived broken, wants a refund",
    };
    const res = await post("order MH20260701123 fell apart, refund");
    expect(res.status).toBe(200);
    expect(await readJson(res, ticketSchema)).toEqual({
      order_id: "MH20260701123",
      request_type: "refund",
      expected_solution: "arrived broken, wants a refund",
    });
  });

  it("normalizes placeholder order ids to null", async () => {
    mocks.state.fail = false;
    mocks.state.result = {
      order_id: "null",
      request_type: "complaint",
      expected_solution: "wants an apology",
    };
    const res = await post("your service is terrible");
    const body = await readJson(res, ticketSchema);
    expect(body.order_id).toBeNull();
  });

  it("maps an upstream failure to 502", async () => {
    mocks.state.fail = true;
    const res = await post("anything");
    expect(res.status).toBe(502);
    expect(await res.json()).toHaveProperty("detail");
  });

  it("validates empty text", async () => {
    expect((await post("")).status).toBe(400);
  });
});
