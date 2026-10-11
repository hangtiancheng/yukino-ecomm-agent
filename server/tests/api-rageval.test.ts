import type { Hono } from "hono";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import type * as DbExports from "#/db/client.ts";
import type * as RepositoryExports from "#/db/repository.ts";
import { readJson } from "#tests/helpers/json.ts";
import { provisionTestDatabase } from "#tests/helpers/test-db.ts";

let app: Hono;
let db: typeof DbExports;
let repository: typeof RepositoryExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_rageval");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

beforeEach(async () => {
  await db.prisma.faithCase.deleteMany();
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

const overviewSchema = z.object({
  present: z.boolean(),
  job: z.object({ specs: z.array(z.object({ name: z.string() })) }),
});

const casesSchema = z.object({
  items: z.array(z.object({ eval_id: z.string(), status: z.string() })),
  total: z.number(),
  counts: z.object({
    unresolved: z.number(),
    resolved: z.number(),
    dismissed: z.number(),
  }),
  hallucination: z.object({ ledger: z.object({ total: z.number() }) }),
});

describe("rag-eval overview", () => {
  it("reports the eval-rag job spec alongside the report state", async () => {
    const res = await app.request("/api/rag-eval/overview");
    expect(res.status).toBe(200);
    const body = await readJson(res, overviewSchema);
    // The report may exist from a previous local run; only assert the shape.
    expect(typeof body.present).toBe("boolean");
    expect(body.job.specs[0]?.name).toBe("eval-rag");
  });
});

describe("faith cases ledger", () => {
  it("lists with counts and pagination", async () => {
    await repository.upsertFaithCase(
      "e1",
      "A_policy",
      "q1",
      "a1",
      "fabricated",
    );
    await repository.upsertFaithCase("e2", "B_model", "q2", "a2", "fabricated");
    const res = await app.request("/api/rag-eval/faith-cases?page=1&size=5");
    expect(res.status).toBe(200);
    const body = await readJson(res, casesSchema);
    expect(body.total).toBe(2);
    expect(body.items.every((i) => i.status === "unresolved")).toBe(true);
    expect(body.counts.unresolved).toBe(2);
    expect(body.hallucination.ledger.total).toBe(2);
  });

  it("rejects an unknown status filter", async () => {
    const res = await app.request("/api/rag-eval/faith-cases?status=magic");
    expect(res.status).toBe(400);
  });

  it("re-judging an existing case bumps seen_count and reopens it", async () => {
    const [id] = await repository.upsertFaithCase(
      "e1",
      "A_policy",
      "q1",
      "a1",
      "fabricated",
    );
    await repository.setFaithCaseStatus(id ?? 0, "resolved", "fixed the KB");
    const [, reopened] = await repository.upsertFaithCase(
      "e1",
      "A_policy",
      "q1",
      "a1 again",
      "fabricated again",
    );
    expect(reopened).toBe(true);
    const row = await db.prisma.faithCase.findUnique({
      where: { id: id ?? 0 },
    });
    expect(row?.status).toBe("unresolved");
    expect(row?.seenCount).toBe(2);
    expect(row?.resolvedAt).not.toBeNull(); // kept for the "reopened" badge
  });

  it("status changes require a resolution note except when reopening", async () => {
    const [id] = await repository.upsertFaithCase(
      "e1",
      "A_policy",
      "q1",
      "a1",
      "fabricated",
    );
    const post = (body: unknown): Promise<Response> =>
      Promise.resolve(
        app.request(`/api/rag-eval/faith-cases/${id ?? 0}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    expect((await post({ status: "resolved" })).status).toBe(400);
    expect(
      (await post({ status: "resolved", resolution: "patched" })).status,
    ).toBe(200);
    expect((await post({ status: "unresolved" })).status).toBe(200);

    const row = await db.prisma.faithCase.findUnique({
      where: { id: id ?? 0 },
    });
    expect(row?.status).toBe("unresolved");
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolution).toBeNull();
  });

  it("404s for a missing case", async () => {
    const res = await app.request("/api/rag-eval/faith-cases/999999/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved", resolution: "x" }),
    });
    expect(res.status).toBe(404);
  });
});
