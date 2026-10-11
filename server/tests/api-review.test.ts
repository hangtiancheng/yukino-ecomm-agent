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
  writePending: vi.fn(),
  vectorizePending: vi.fn(),
  deleteChunks: vi.fn(),
}));

vi.mock("#/kb/dualwrite.ts", () => ({
  writePending: mocks.writePending,
  vectorizePending: mocks.vectorizePending,
  deleteChunks: mocks.deleteChunks,
  rependChunks: vi.fn(),
}));

let app: Hono;
let db: typeof DbExports;
let repository: typeof RepositoryExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_review");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

beforeEach(async () => {
  mocks.writePending.mockReset();
  mocks.vectorizePending.mockReset();
  mocks.deleteChunks.mockReset();
  mocks.writePending.mockResolvedValue([101]);
  mocks.vectorizePending.mockResolvedValue(1);
  await db.prisma.$transaction([
    db.prisma.lowConfidenceQuestion.deleteMany(),
    db.prisma.reviewQueue.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

async function seedGap(question = "is the cat bed washable"): Promise<number> {
  const lid = await repository.insertLowConfidence(
    null,
    "can the cat bed be washed",
    "retrieval_low_conf",
    "top1=0.1",
  );
  const match = await repository.matchLowConfidence(lid, question, null, null);
  if (match === null) {
    throw new Error("seedGap: matchLowConfidence returned null");
  }
  return match.reviewId;
}

const queueSchema = z.object({ items: z.array(z.object({ id: z.number() })) });
const detailSchema = z.object({
  normalized_question: z.string(),
  raws: z.array(z.object({ raw_question: z.string() })),
});
const approveSchema = z.object({
  ok: z.boolean(),
  chunk_ids: z.array(z.number()),
});

function postJson(path: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("review API", () => {
  it("lists the queue ordered by occurrence", async () => {
    const a = await seedGap("question A");
    const b = await seedGap("question B");
    await repository.matchLowConfidence(
      await repository.insertLowConfidence(
        null,
        "b again",
        "user_feedback",
        null,
      ),
      "question B",
      null,
      b,
    );
    const res = await app.request("/api/review/queue?status=pending_review");
    const body = await readJson(res, queueSchema);
    expect(body.items.map((i) => i.id)).toEqual([b, a]);
  });

  it("404s on a missing gap", async () => {
    expect((await app.request("/api/review/999999")).status).toBe(404);
  });

  it("detail carries merged raws", async () => {
    const rid = await seedGap();
    const res = await app.request(`/api/review/${rid}`);
    const body = await readJson(res, detailSchema);
    expect(body.normalized_question).toBe("is the cat bed washable");
    expect(body.raws.map((r) => r.raw_question)).toEqual([
      "can the cat bed be washed",
    ]);
  });

  it("approve writes back to the KB, vectorizes, then flips the status", async () => {
    const rid = await seedGap();
    const res = await postJson(`/api/review/${rid}/approve`, {
      approved_answer: "yes, hand wash only",
    });
    expect(res.status).toBe(200);
    expect(await readJson(res, approveSchema)).toEqual({
      ok: true,
      chunk_ids: [101],
    });
    expect(mocks.writePending).toHaveBeenCalledTimes(1);
    expect(mocks.vectorizePending).toHaveBeenCalledTimes(1);
    const detail = await repository.getReviewDetail(rid);
    expect(detail?.item.reviewStatus).toBe("approved");
    expect(detail?.item.approvedAnswer).toBe("yes, hand wash only");
  });

  it("approve rolls back inserted chunks when vectorization fails", async () => {
    mocks.vectorizePending.mockRejectedValue(
      new Error("embedding upstream down"),
    );
    const rid = await seedGap();
    const res = await postJson(`/api/review/${rid}/approve`, {
      approved_answer: "yes",
    });
    expect(res.status).toBe(502);
    const calls: unknown[] = mocks.deleteChunks.mock.calls[0] ?? [];
    expect(calls[0]).toEqual([101]);
    const detail = await repository.getReviewDetail(rid);
    expect(detail?.item.reviewStatus).toBe("pending_review"); // retryable
  });

  it("cannot review twice", async () => {
    const rid = await seedGap();
    await postJson(`/api/review/${rid}/approve`, { approved_answer: "yes" });
    const again = await postJson(`/api/review/${rid}/approve`, {
      approved_answer: "yes again",
    });
    expect(again.status).toBe(409);
  });

  it("reject flips to rejected and is terminal", async () => {
    const rid = await seedGap();
    const res = await app.request(`/api/review/${rid}/reject`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const again = await app.request(`/api/review/${rid}/reject`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
  });

  it("approve requires a non-empty answer", async () => {
    const rid = await seedGap();
    const res = await postJson(`/api/review/${rid}/approve`, {
      approved_answer: "",
    });
    expect(res.status).toBe(400);
  });
});
