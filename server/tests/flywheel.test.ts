import fs from "node:fs";
import path from "node:path";

import { RunnableLambda } from "@langchain/core/runnables";
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
import { z } from "zod";

import type * as FlywheelExports from "#/core/flywheel.ts";
import type * as DbExports from "#/db/client.ts";
import type * as RepositoryExports from "#/db/repository.ts";

type QueueEntry =
  | ((input: unknown) => Record<string, unknown>)
  | Error
  | Record<string, unknown>;

const mocks = vi.hoisted(() => {
  const queue: QueueEntry[] = [];
  return { queue };
});

vi.mock("#/core/llm.ts", () => ({
  structured: () =>
    RunnableLambda.from(async (input: unknown) => {
      await Promise.resolve();
      const next = mocks.queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (typeof next === "function") {
        return next(input);
      }
      return next;
    }),
}));

let db: typeof DbExports;
let flywheel: typeof FlywheelExports;
let repository: typeof RepositoryExports;
let admin: Client;
let dbName: string;

const baseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1:5432/postgres",
);

beforeAll(async () => {
  dbName = `yukino_agent2_flywheel_test_${Date.now()}_${process.pid}`;
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
  flywheel = await import("#/core/flywheel.ts");
  repository = await import("#/db/repository.ts");
});

beforeEach(async () => {
  mocks.queue.length = 0;
  await db.prisma.$transaction([
    db.prisma.lowConfidenceQuestion.deleteMany(),
    db.prisma.reviewQueue.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  delete process.env.DATABASE_URL;
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe("flywheel process_pending", () => {
  it("creates a pending review item for a new question and advances the cursor", async () => {
    await repository.insertLowConfidence(
      null,
      "can the cat bed be washed",
      "retrieval_low_conf",
      null,
    );
    mocks.queue.push({
      normalized_question: "is the cat bed washable",
      matched_question_id: null,
      ai_suggested_answer: "subject to the platform after-sales rules",
    });
    const stats = await flywheel.processPending();
    expect(stats).toEqual({ processed: 1, merged: 0, created: 1, skipped: 0 });
    const rows = await repository.listReviewQueue("pending_review");
    expect(rows[0].normalizedQuestion).toBe("is the cat bed washable");
    expect(await repository.fetchUnmatchedLowConf(10)).toEqual([]);
  });

  it("merges into an existing item without reviving a rejected one", async () => {
    const first = await repository.matchLowConfidence(
      await repository.insertLowConfidence(null, "seed", "user_feedback", null),
      "is the cat bed washable",
      null,
      null,
    );
    await repository.updateReviewStatus(first?.reviewId ?? 0, "rejected");
    await repository.insertLowConfidence(
      null,
      "can it go in the wash",
      "user_feedback",
      null,
    );
    mocks.queue.push({
      normalized_question: "is the cat bed washable",
      matched_question_id: first?.reviewId ?? 0,
      ai_suggested_answer: "",
    });
    const stats = await flywheel.processPending();
    expect(stats.merged).toBe(1);
    expect(stats.created).toBe(0);
    const detail = await repository.getReviewDetail(first?.reviewId ?? 0);
    expect(detail?.item.occurrenceCount).toBe(2);
    expect(detail?.item.reviewStatus).toBe("rejected"); // only count up, never revive
    expect(detail?.raws.map((r) => r.rawQuestion)).toEqual([
      "seed",
      "can it go in the wash",
    ]);
  });

  it("skips a hallucinated candidate id and keeps the cursor for the next round", async () => {
    await repository.insertLowConfidence(
      null,
      "can it go in the wash",
      "self_check",
      null,
    );
    mocks.queue.push({
      normalized_question: "is the cat bed washable",
      matched_question_id: 99999,
      ai_suggested_answer: "",
    });
    const stats = await flywheel.processPending();
    expect(stats.skipped).toBe(1);
    expect(stats.processed).toBe(0);
    expect(await repository.fetchUnmatchedLowConf(10)).toHaveLength(1);
    expect(await repository.listReviewQueue(null)).toEqual([]);
  });

  it("skips a row whose normalization fails and keeps going", async () => {
    await repository.insertLowConfidence(null, "one", "self_check", null);
    await repository.insertLowConfidence(null, "two", "self_check", null);
    mocks.queue.push(new Error("bad json"));
    mocks.queue.push({
      normalized_question: "standard two",
      matched_question_id: null,
      ai_suggested_answer: "",
    });
    const stats = await flywheel.processPending();
    expect(stats).toEqual({ processed: 1, merged: 0, created: 1, skipped: 1 });
  });

  it("merges same-batch duplicates serially", async () => {
    // Two synonyms in one batch: the second row must see the review item the
    // first row just created among its candidates, so it merges instead of
    // creating a duplicate gap.
    await repository.insertLowConfidence(
      null,
      "can the cat bed be washed",
      "retrieval_low_conf",
      null,
    );
    await repository.insertLowConfidence(
      null,
      "can it go in the wash",
      "user_feedback",
      null,
    );
    const seenCandidates: string[] = [];
    const decide = (input: unknown) => {
      // The stub receives the formatted prompt value; pull the human text.
      const parsed = z
        .object({ messages: z.array(z.object({ content: z.unknown() })) })
        .safeParse(input);
      const text = parsed.success
        ? parsed.data.messages
            .map((m) =>
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content ?? ""),
            )
            .join("\n")
        : JSON.stringify(input);
      seenCandidates.push(text);
      const m = /id=(\d+)/.exec(text);
      return {
        normalized_question: "is the cat bed washable",
        matched_question_id: m ? Number(m[1]) : null,
        ai_suggested_answer: "",
      };
    };
    mocks.queue.push(decide, decide);
    const stats = await flywheel.processPending();
    expect(stats).toEqual({ processed: 2, merged: 1, created: 1, skipped: 0 });
    expect(seenCandidates[0]).toContain("(no candidates)");
    expect(seenCandidates[1]).toContain("is the cat bed washable");
    const rows = await repository.listReviewQueue(null);
    expect(rows).toHaveLength(1);
    expect(rows[0].occurrenceCount).toBe(2);
  });
});
