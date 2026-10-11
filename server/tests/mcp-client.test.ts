import { afterEach, describe, expect, it } from "vitest";

import { settings } from "#/config.ts";
import { FORMATTERS, fetchMcpSpecs } from "#/tools/mcp-client.ts";

const saved = {
  logistics: settings.mcpLogisticsUrl,
  aftersales: settings.mcpAftersalesUrl,
};

afterEach(() => {
  settings.mcpLogisticsUrl = saved.logistics;
  settings.mcpAftersalesUrl = saved.aftersales;
});

describe("mcp result formatters", () => {
  it("logistics: picks fields and translates the status code", () => {
    const out = FORMATTERS.query_logistics({
      tracking_no: "SF1",
      status_code: "IN_TRANSIT",
      current_city: "Shenzhen",
      trace: ["Shenzhen sorting center: dispatched"],
      carrier_code: "SF-EXP-01",
    });
    expect(out).toEqual({
      tracking_no: "SF1",
      status: "In transit",
      current_city: "Shenzhen",
      trace: ["Shenzhen sorting center: dispatched"],
    });
  });

  it("warranty: translates the warranty code and drops internals", () => {
    const out = FORMATTERS.query_warranty({
      order_id: "1001",
      warranty_code: "IN_WARRANTY",
      warranty_until: "2026-10-01",
      policy_ref: "AS-POLICY-07",
    });
    expect(out).toEqual({
      order_id: "1001",
      warranty: "Under warranty",
      warranty_until: "2026-10-01",
    });
  });

  it("return status: translates the return code", () => {
    const out = FORMATTERS.query_return_status({
      order_id: "1001",
      return_code: "REFUNDED",
      updated_at: "2026-07-01 10:00",
    });
    expect(out).toEqual({
      order_id: "1001",
      return_status: "Refunded",
      updated_at: "2026-07-01 10:00",
    });
  });

  it("unknown codes pass through unchanged", () => {
    const out = FORMATTERS.query_logistics({
      tracking_no: "SF1",
      status_code: "SOMETHING_NEW",
    });
    expect(out.status).toBe("SOMETHING_NEW");
  });

  it("a type-mismatched payload degrades to pass-through", () => {
    const input = { tracking_no: 123, status_code: "IN_TRANSIT" };
    expect(FORMATTERS.query_logistics(input)).toBe(input);
  });
});

describe("fetchMcpSpecs degradation", () => {
  it("unreachable servers are skipped without throwing", async () => {
    // Closed ports: connection refused must degrade to "no MCP tools this
    // turn" instead of taking the whole conversation down.
    settings.mcpLogisticsUrl = "http://127.0.0.1:19999/mcp";
    settings.mcpAftersalesUrl = "http://127.0.0.1:19998/mcp";
    const specs = await fetchMcpSpecs();
    expect(specs).toEqual([]);
  }, 30_000);
});
