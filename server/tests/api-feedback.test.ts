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
  getTurnSnapshot: vi.fn(),
}));

vi.mock("#/graph/runtime.ts", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("#/graph/runtime.ts");
  return { ...actual, getTurnSnapshot: mocks.getTurnSnapshot };
});

let app: Hono;
let db: typeof DbExports;
let repository: typeof RepositoryExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_feedback");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

beforeEach(async () => {
  mocks.getTurnSnapshot.mockReset();
  await db.prisma.$transaction([
    db.prisma.lowConfidenceQuestion.deleteMany(),
    db.prisma.message.deleteMany(),
    db.prisma.conversation.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

function post(body: unknown): Promise<Response> {
  return Promise.resolve(
    app.request("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const feedbackSchema = z.object({ ok: z.boolean(), pooled: z.boolean() });

describe("/api/feedback", () => {
  it("thumbs up only logs, never pools", async () => {
    const res = await post({
      conversation_id: 1,
      rating: "up",
      question: "was that helpful",
    });
    expect(res.status).toBe(200);
    expect(await readJson(res, feedbackSchema)).toEqual({
      ok: true,
      pooled: false,
    });
    expect(await db.prisma.lowConfidenceQuestion.count()).toBe(0);
  });

  it("thumbs down pools with the matching snapshot", async () => {
    const cid = await repository.createConversation("u1");
    const snapshot = [
      { question: "q", answer: "a", rerank_score: 0.4, section_path: "s" },
    ];
    mocks.getTurnSnapshot.mockResolvedValue({
      question: "can the cat bed be washed",
      snapshot,
    });
    const res = await post({
      conversation_id: cid,
      rating: "down",
      question: "can the cat bed be washed",
    });
    expect(await readJson(res, feedbackSchema)).toEqual({
      ok: true,
      pooled: true,
    });
    const rows = await db.prisma.lowConfidenceQuestion.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("user_feedback");
    expect(JSON.parse(rows[0]?.retrievedChunks ?? "null")).toEqual(snapshot);
  });

  it("pools without a snapshot when the question does not match", async () => {
    const cid = await repository.createConversation("u1");
    mocks.getTurnSnapshot.mockResolvedValue({
      question: "a different question",
      snapshot: [{ question: "q" }],
    });
    await post({
      conversation_id: cid,
      rating: "down",
      question: "can the cat bed be washed",
    });
    const rows = await db.prisma.lowConfidenceQuestion.findMany();
    expect(rows[0]?.retrievedChunks).toBeNull();
  });

  it("still pools when the snapshot lookup fails", async () => {
    const cid = await repository.createConversation("u1");
    mocks.getTurnSnapshot.mockRejectedValue(new Error("no checkpoint"));
    const res = await post({
      conversation_id: cid,
      rating: "down",
      question: "can the cat bed be washed",
    });
    expect(await readJson(res, feedbackSchema)).toEqual({
      ok: true,
      pooled: true,
    });
    expect(await db.prisma.lowConfidenceQuestion.count()).toBe(1);
  });
});
