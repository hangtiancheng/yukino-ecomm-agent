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

const mocks = vi.hoisted(() => ({
  vectorizePending: vi.fn(),
  deleteChunks: vi.fn(),
}));

vi.mock("#/kb/dualwrite.ts", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("#/kb/dualwrite.ts");
  return {
    ...actual,
    vectorizePending: mocks.vectorizePending,
    deleteChunks: mocks.deleteChunks,
  };
});

let app: Hono;
let db: typeof DbExports;
let repository: typeof RepositoryExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_kb");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

beforeEach(async () => {
  mocks.vectorizePending.mockReset();
  mocks.deleteChunks.mockReset();
  mocks.vectorizePending.mockResolvedValue(0);
  await db.prisma.$transaction([
    db.prisma.qaExtractionStaging.deleteMany(),
    db.prisma.knowledgeChunk.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

function post(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const previewSchema = z.object({
  total: z.number(),
  duplicates: z.number(),
  dedup_known: z.boolean(),
  chunks: z.array(
    z.object({ questions: z.string(), duplicate: z.boolean().nullable() }),
  ),
});
const ingestSchema = z.object({
  inserted: z.number(),
  skipped: z.number(),
  vectorized: z.number().nullable(),
});
const stagingApproveSchema = z.object({
  approved: z.number(),
  chunk_ids: z.array(z.number()),
});
const overviewSchema = z.object({
  chunks: z.object({ total: z.number().nullable() }),
  sources: z.array(z.object({ file: z.string(), present: z.boolean() })),
  jobs: z.array(z.object({ name: z.string() })),
  content_types: z.array(z.object({ key: z.string() })),
});

describe("kb preview", () => {
  it("is a dry run: chunks without touching the DB", async () => {
    const res = await post("/api/kb/preview", {
      text: "# Policy\n\n## Shipping\n\nFree shipping over 99 yuan.",
      content_type: "policy",
    });
    expect(res.status).toBe(200);
    const body = await readJson(res, previewSchema);
    expect(body.total).toBeGreaterThan(0);
    expect(body.chunks[0]?.questions).toBe("Shipping");
    expect(await db.prisma.knowledgeChunk.count()).toBe(0);
  });

  it("flags duplicates against the existing library", async () => {
    await repository.insertKnowledgeChunks([
      {
        category: "Policy",
        questions: "Shipping",
        answer: "Free shipping over 99 yuan.",
        sectionPath: "Policy / Shipping",
        contentType: "policy",
      },
    ]);
    const res = await post("/api/kb/preview", {
      text: "# Policy\n\n## Shipping\n\nFree shipping over 99 yuan.",
      content_type: "policy",
    });
    const body = await readJson(res, previewSchema);
    expect(body.duplicates).toBe(1);
  });

  it("rejects an empty text and an unknown content type", async () => {
    expect((await post("/api/kb/preview", { text: "" })).status).toBe(400);
    expect(
      (await post("/api/kb/preview", { text: "x", content_type: "magic" }))
        .status,
    ).toBe(400);
  });

  it("only accepts whitelisted material files", async () => {
    const res = await post("/api/kb/preview", {
      file: "../../etc/passwd",
      content_type: "faq",
    });
    expect(res.status).toBe(400);
  });
});

describe("kb ingest", () => {
  const text =
    "# Policy\n\n## Shipping\n\nFree shipping over 99 yuan.\n\n## Returns\n\n7-day no-reason returns.";

  it("stores deduped chunks and skips the rest", async () => {
    const res = await post("/api/kb/ingest", {
      text,
      content_type: "policy",
      vectorize: false,
    });
    expect(res.status).toBe(200);
    const first = await readJson(res, ingestSchema);
    expect(first.inserted).toBe(2);

    // re-ingesting the same text is idempotent via fingerprints
    const res2 = await post("/api/kb/ingest", {
      text,
      content_type: "policy",
      vectorize: false,
    });
    const second = await readJson(res2, ingestSchema);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("vectorizes on request", async () => {
    mocks.vectorizePending.mockResolvedValue(2);
    const res = await post("/api/kb/ingest", {
      text: "# A\n\n## B\n\nbody text here.",
      content_type: "faq",
      vectorize: true,
    });
    const body = await readJson(res, ingestSchema);
    expect(body.vectorized).toBe(2);
    expect(mocks.vectorizePending).toHaveBeenCalled();
  });

  it("rejects text that produces no chunks", async () => {
    const res = await post("/api/kb/ingest", {
      text: "# Only a heading",
      content_type: "faq",
      vectorize: false,
    });
    expect(res.status).toBe(400);
  });
});

describe("kb search validation", () => {
  it("rejects an empty question and a bad strategy", async () => {
    expect((await post("/api/kb/search", { q: "  " })).status).toBe(400);
    expect(
      (await post("/api/kb/search", { q: "x", strategy: "magic" })).status,
    ).toBe(400);
  });
});

describe("kb staging review", () => {
  async function seedStaging(status = "kept"): Promise<number> {
    const id = await repository.insertStaging(
      "mine-20260101000000",
      "conv:1",
      "how long does shipping take",
      "48 hours for in-stock items",
    );
    if (status !== "extracted") {
      await repository.setStagingStatus([id], status);
    }
    return id;
  }

  it("approve writes kept rows into the KB and marks them approved", async () => {
    const id = await seedStaging();
    const res = await post("/api/kb/staging/approve", { ids: [id] });
    expect(res.status).toBe(200);
    const body = await readJson(res, stagingApproveSchema);
    expect(body.approved).toBe(1);
    const rows = await repository.listStagingByStatus("approved");
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(await db.prisma.knowledgeChunk.count()).toBe(1);
  });

  it("approve only accepts rows in the kept state", async () => {
    const id = await seedStaging("rejected");
    const res = await post("/api/kb/staging/approve", { ids: [id] });
    expect(res.status).toBe(409);
  });

  it("reject marks rows rejected without touching the KB", async () => {
    const id = await seedStaging();
    const res = await post("/api/kb/staging/reject", { ids: [id] });
    expect(res.status).toBe(200);
    expect(await db.prisma.knowledgeChunk.count()).toBe(0);
    expect(await repository.listStagingByStatus("rejected")).toHaveLength(1);
  });

  it("requires at least one id", async () => {
    expect((await post("/api/kb/staging/approve", { ids: [] })).status).toBe(
      400,
    );
  });
});

describe("kb overview", () => {
  it("reports inventory, sources and job buttons", async () => {
    const res = await app.request("/api/kb/overview");
    expect(res.status).toBe(200);
    const body = await readJson(res, overviewSchema);
    expect(body.chunks.total).toBe(0);
    expect(body.sources.length).toBeGreaterThan(0);
    expect(body.jobs.map((j) => j.name)).toContain("kb-build");
    expect(body.content_types.map((t) => t.key)).toEqual([
      "faq",
      "policy",
      "manual",
      "spec",
    ]);
  });
});
