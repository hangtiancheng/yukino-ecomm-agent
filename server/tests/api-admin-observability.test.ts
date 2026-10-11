import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as DbExports from "#/db/client.ts";
import { readJson } from "#tests/helpers/json.ts";
import { provisionTestDatabase } from "#tests/helpers/test-db.ts";

let app: Hono;
let db: typeof DbExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_admin");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

const adminSchema = z.object({
  modules: z.array(
    z.object({ key: z.string(), status: z.string(), headline: z.string() }),
  ),
});
const jobsSchema = z.object({ jobs: z.array(z.object({ name: z.string() })) });
const observabilitySchema = z.object({
  cost: z.object({ status: z.string(), job: z.object({ name: z.string() }) }),
  trend: z.object({
    status: z.string(),
    metric_names: z.array(z.string()),
  }),
  calibration: z.object({
    status: z.string(),
    in_use: z.number(),
    weights: z.record(z.string(), z.number()),
  }),
});

describe("admin overview", () => {
  it("returns the four module cards, each self-contained", async () => {
    const res = await app.request("/api/admin/overview");
    expect(res.status).toBe(200);
    const body = await readJson(res, adminSchema);
    expect(body.modules.map((m) => m.key)).toEqual([
      "kb",
      "rageval",
      "review",
      "observability",
    ]);
    for (const m of body.modules) {
      // a card whose dependency is down still renders with its own status
      expect(["ok", "attention", "missing", "error"]).toContain(m.status);
      expect(m.headline.length).toBeGreaterThan(0);
    }
  });

  it("exposes job statuses for the admin page", async () => {
    const res = await app.request("/api/admin/jobs");
    expect(res.status).toBe(200);
    const body = await readJson(res, jobsSchema);
    expect(body.jobs.map((j) => j.name)).toContain("kb-build");
  });
});

describe("observability overview", () => {
  it("returns the three blocks without 500s when nothing has run", async () => {
    const res = await app.request("/api/observability/overview");
    expect(res.status).toBe(200);
    const body = await readJson(res, observabilitySchema);
    expect(["missing", "ok", "error"]).toContain(body.cost.status);
    expect(body.cost.job.name).toBe("cost-report");
    expect(body.trend.metric_names).toEqual([
      "recall_at_5",
      "recall_at_10",
      "mrr",
      "faithfulness",
      "refusal_rate",
    ]);
    expect(body.calibration.in_use).toBeGreaterThan(0);
    expect(body.calibration.weights).toEqual({
      top1: 0.5,
      valid_count: 0.2,
      margin: 0.2,
      key_clause: 0.1,
    });
  });
});
