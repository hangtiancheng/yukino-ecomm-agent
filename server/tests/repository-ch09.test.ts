import fs from "node:fs";
import path from "node:path";

import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { settings } from "#/config.ts";
import type * as DbExports from "#/db/client.ts";
import type * as RepositoryExports from "#/db/repository.ts";

let db: typeof DbExports;
let repository: typeof RepositoryExports;
let admin: Client;
let dbName: string;

const baseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1:5432/postgres",
);

beforeAll(async () => {
  dbName = `yukino_agent2_ch09_test_${Date.now()}_${process.pid}`;
  admin = new Client({ connectionString: baseUrl.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);

  const migrationsDir = path.join(process.cwd(), "prisma/migrations");
  const migrations = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const targetUrl = new URL(`/${dbName}`, baseUrl).toString();
  const target = new Client({ connectionString: targetUrl });
  await target.connect();
  try {
    for (const migration of migrations) {
      await target.query(
        fs.readFileSync(
          path.join(migrationsDir, migration.name, "migration.sql"),
          "utf8",
        ),
      );
    }
  } finally {
    await target.end();
  }

  process.env.DATABASE_URL = targetUrl;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
});

beforeEach(async () => {
  await db.prisma.$transaction([
    db.prisma.lowConfidenceQuestion.deleteMany(),
    db.prisma.reviewQueue.deleteMany(),
    db.prisma.evalRun.deleteMany(),
    db.prisma.toolAuditLog.deleteMany(),
    db.prisma.message.deleteMany(),
    db.prisma.conversationSummary.deleteMany(),
    db.prisma.conversation.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  delete process.env.DATABASE_URL;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("low-confidence pool", () => {
  it("stores the question with source and reason", async () => {
    const cid = await repository.createConversation("u1");
    const lid = await repository.insertLowConfidence(
      cid,
      "how much is shipping really",
      "self_check",
      "evidence insufficient",
    );
    expect(lid).toBeGreaterThan(0);
    const row = await db.prisma.lowConfidenceQuestion.findUnique({
      where: { id: lid },
    });
    expect(row?.source).toBe("self_check");
    expect(row?.rawQuestion).toBe("how much is shipping really");
  });

  it("accepts a null conversation", async () => {
    const lid = await repository.insertLowConfidence(
      null,
      "question without a conversation",
      "retrieval_low_conf",
      null,
    );
    expect(lid).toBeGreaterThan(0);
  });

  it("round-trips the retrieved snapshot", async () => {
    const snap = [
      {
        question: "who pays return shipping",
        answer: "free over 99",
        rerank_score: 0.91,
        section_path: "after-sales / returns",
      },
    ];
    const lid = await repository.insertLowConfidence(
      null,
      "can the cat bed be washed",
      "retrieval_low_conf",
      "top1=0.2",
      snap,
    );
    const rows = await repository.fetchUnmatchedLowConf(10);
    expect(rows.map((r) => r.id)).toEqual([lid]);
    expect(JSON.parse(rows[0]?.retrievedChunks ?? "null")).toEqual(snap);
    expect(rows[0]?.matchedReviewId).toBeNull();
  });

  it("keeps a missing snapshot as null", async () => {
    await repository.insertLowConfidence(
      null,
      "question that never ran retrieval",
      "user_feedback",
      null,
    );
    const rows = await repository.fetchUnmatchedLowConf(10);
    expect(rows[0]?.retrievedChunks).toBeNull();
  });
});

describe("review queue", () => {
  it("creates items and links merged raws", async () => {
    const lid = await repository.insertLowConfidence(
      null,
      "can it be washed",
      "user_feedback",
      null,
    );
    const match = await repository.matchLowConfidence(
      lid,
      "is the cat bed washable",
      "suggested answer",
      null,
    );
    expect(match?.created).toBe(true);
    const reviewId = match?.reviewId ?? 0;
    const detail = await repository.getReviewDetail(reviewId);
    expect(detail).not.toBeNull();
    expect(detail?.item.occurrenceCount).toBe(1);
    expect(detail?.item.reviewStatus).toBe("pending_review");
    expect(detail?.raws.map((r) => r.id)).toEqual([lid]);
    // merged rows leave the unmatched cursor
    expect(await repository.fetchUnmatchedLowConf(10)).toEqual([]);
  });

  it("merging increments occurrence without reviving a rejected item", async () => {
    const first = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "q1", "user_feedback", null),
      "is the cat bed washable",
      null,
      null,
    );
    const firstId = first?.reviewId ?? 0;
    await repository.updateReviewStatus(firstId, "rejected");
    const second = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "q2", "user_feedback", null),
      "is the cat bed washable",
      null,
      firstId,
    );
    expect(second?.created).toBe(false);
    const detail = await repository.getReviewDetail(firstId);
    expect(detail?.item.occurrenceCount).toBe(2);
    expect(detail?.item.reviewStatus).toBe("rejected"); // terminal, not revived
  });

  it("status only transitions out of pending_review", async () => {
    const match = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "q", "user_feedback", null),
      "normalized",
      null,
      null,
    );
    const reviewId = match?.reviewId ?? 0;
    expect(
      await repository.updateReviewStatus(
        reviewId,
        "approved",
        "washable, yes",
      ),
    ).toBe(true);
    const detail = await repository.getReviewDetail(reviewId);
    expect(detail?.item.reviewStatus).toBe("approved");
    expect(detail?.item.approvedAnswer).toBe("washable, yes");
    // an approved item is final
    expect(await repository.updateReviewStatus(reviewId, "rejected")).toBe(
      false,
    );
  });

  it("lists the queue ordered by occurrence, filterable by status", async () => {
    const a = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "qa", "user_feedback", null),
      "question A",
      null,
      null,
    );
    const b = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "qb", "user_feedback", null),
      "question B",
      null,
      null,
    );
    const aId = a?.reviewId ?? 0;
    const bId = b?.reviewId ?? 0;
    await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "qc", "user_feedback", null),
      "question B again",
      null,
      bId,
    );
    const pending = await repository.listReviewQueue("pending_review");
    expect(pending.map((r) => r.id)).toEqual([bId, aId]);
    await repository.updateReviewStatus(aId, "rejected");
    expect(
      (await repository.listReviewQueue("pending_review")).map((r) => r.id),
    ).toEqual([bId]);
    expect(await repository.listReviewQueue(null)).toHaveLength(2);
  });

  it("exposes candidates for the flywheel prompt", async () => {
    const match = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "q", "user_feedback", null),
      "is the cat bed washable",
      null,
      null,
    );
    const candidates = await repository.listReviewCandidates(200);
    expect(candidates).toEqual([
      {
        id: match?.reviewId ?? 0,
        normalized_question: "is the cat bed washable",
      },
    ]);
  });
});

describe("summary segments", () => {
  it("appends with an increasing seq", async () => {
    const cid = await repository.createConversation("u_seg");
    expect(await repository.appendSummarySegment(cid, 1, 10, "seg 1")).toBe(1);
    expect(await repository.appendSummarySegment(cid, 11, 20, "seg 2")).toBe(2);
  });

  it("projects the recent segments without duplicates", async () => {
    const cid = await repository.createConversation("u_seg");
    for (let i = 1; i <= 4; i += 1) {
      await repository.appendSummarySegment(
        cid,
        i * 10 - 9,
        i * 10,
        `segment ${i}`,
      );
    }
    const conv = await repository.getConversation(cid);
    const lines = (conv?.summary ?? "").split("\n");
    expect(lines).toHaveLength(settings.summaryInjectSegments);
    expect(new Set(lines).size).toBe(lines.length);
    expect(lines.at(-1)).toBe("segment 4");
  });

  it("keeps old segments in the table but out of the injection window", async () => {
    const cid = await repository.createConversation("u_seg");
    for (let i = 1; i <= 5; i += 1) {
      await repository.appendSummarySegment(
        cid,
        i * 10 - 9,
        i * 10,
        `segment ${i}`,
      );
    }
    expect(await repository.listSummarySegments(cid)).toHaveLength(
      settings.summaryInjectSegments,
    );
    expect(await repository.listSummarySegments(cid, 99)).toHaveLength(5);
  });

  it("advances the conversation boundary with each segment", async () => {
    const cid = await repository.createConversation("u_seg");
    await repository.appendSummarySegment(cid, 1, 100, "seg 1");
    expect((await repository.getConversation(cid))?.summaryUptoMsgId).toBe(100);
    await repository.appendSummarySegment(cid, 101, 250, "seg 2");
    expect((await repository.getConversation(cid))?.summaryUptoMsgId).toBe(250);
  });
});

describe("tool audit log", () => {
  it("accepts a minimal row without conversation context", async () => {
    await repository.insertToolAudit({
      conversationId: null,
      toolCallId: null,
      toolName: "query_order",
      toolSource: "builtin",
      mcpServer: null,
      arguments: { order_id: "1001" },
      resultSummary: "{}",
      status: "success",
      errorMessage: null,
      retryCount: 0,
      durationMs: 12,
    });
    const rows = await db.prisma.toolAuditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("query_order");
    expect(rows[0].status).toBe("success");
    expect(rows[0].conversationId).toBeNull();
    expect(JSON.parse(rows[0].arguments ?? "null")).toEqual({
      order_id: "1001",
    });
  });

  it("records every outcome status", async () => {
    for (const st of [
      "success",
      "failed",
      "timeout",
      "validation_blocked",
      "permission_denied",
    ]) {
      await repository.insertToolAudit({
        conversationId: 1,
        toolCallId: "tc-1",
        toolName: "create_ticket",
        toolSource: "mcp",
        mcpServer: "logistics",
        arguments: null,
        resultSummary: null,
        status: st,
        errorMessage: "reason",
        retryCount: 2,
        durationMs: null,
      });
    }
    const rows = await db.prisma.toolAuditLog.findMany();
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set([
        "success",
        "failed",
        "timeout",
        "validation_blocked",
        "permission_denied",
      ]),
    );
  });
});

describe("eval runs", () => {
  it("round-trips metrics, newest first", async () => {
    await repository.insertEvalRun("manual", 40, {
      recall_at_10: 0.85,
      mrr: 0.72,
    });
    await repository.insertEvalRun("scheduled", 40, {
      recall_at_10: 0.88,
      mrr: 0.74,
    });
    const runs = await repository.listEvalRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].metrics.recall_at_10).toBe(0.88);
    expect(runs[1].triggeredBy).toBe("manual");
  });
});
