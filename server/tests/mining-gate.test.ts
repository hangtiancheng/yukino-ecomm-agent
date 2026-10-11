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

import type * as DbExports from "#/db/client.ts";
import type * as RepositoryExports from "#/db/repository.ts";
import type * as MiningExports from "#/kb/mining.ts";

const mocks = vi.hoisted(() => {
  const pairs: { questions: string[]; answers: string[] } = {
    questions: [],
    answers: [],
  };
  return { pairs };
});

vi.mock("#/core/llm.ts", () => ({
  structured: () =>
    RunnableLambda.from(async () => {
      await Promise.resolve();
      return {
        questions: [...mocks.pairs.questions],
        answers: [...mocks.pairs.answers],
      };
    }),
}));

let db: typeof DbExports;
let mining: typeof MiningExports;
let repository: typeof RepositoryExports;
let admin: Client;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const baseUrl = new URL(
    process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1:5432/postgres",
  );
  const dbName = `yukino_mining_test_${Date.now()}_${process.pid}`;
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
  mining = await import("#/kb/mining.ts");
  repository = await import("#/db/repository.ts");
  cleanup = async () => {
    delete process.env.DATABASE_URL;
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  };
});

beforeEach(async () => {
  mocks.pairs = { questions: [], answers: [] };
  await db.prisma.$transaction([
    db.prisma.qaExtractionStaging.deleteMany(),
    db.prisma.knowledgeChunk.deleteMany(),
    db.prisma.message.deleteMany(),
    db.prisma.conversation.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

async function seedConversation(): Promise<void> {
  const cid = await repository.createConversation("seed-u1");
  await repository.appendMessage(cid, "user", {
    content: "how is shipping calculated",
  });
  await repository.appendMessage(cid, "assistant", {
    content: "free shipping over 99 yuan",
  });
}

describe("mining review gate", () => {
  it("mine() stops at staging and never writes knowledge_chunks", async () => {
    // The mined pairs are model summaries of chat logs; they may only hold for
    // one order or carry placeholders. The single door into the KB is the
    // human staging approval, so mining itself must not insert chunks.
    await seedConversation();
    mocks.pairs = {
      questions: ["how is shipping calculated"],
      answers: ["free shipping over 99 yuan"],
    };

    const stats = await mining.mine();
    expect(stats.sources).toBe(1);
    expect(stats.extracted).toBe(1);
    expect(stats.kept).toBe(1);
    expect(await db.prisma.knowledgeChunk.count()).toBe(0);
    const kept = await repository.listStagingByStatus("kept");
    expect(kept).toHaveLength(1);
    expect(kept[0]?.question).toBe("how is shipping calculated");
  });

  it("dedups against the existing library and within the batch", async () => {
    await seedConversation();
    await repository.insertKnowledgeChunks([
      {
        category: "policy",
        questions: "how is shipping calculated",
        answer: "free shipping over 99 yuan",
      },
    ]);
    mocks.pairs = {
      questions: [
        "how is shipping calculated", // already in the KB
        "how is shipping calculated", // duplicate within the batch
        "what is the return window",
      ],
      answers: ["a1", "a1", "7 days no reason"],
    };

    const stats = await mining.mine();
    expect(stats.extracted).toBe(3);
    expect(stats.kept).toBe(1);
    expect(stats.discarded).toBe(2);
    expect(await db.prisma.knowledgeChunk.count()).toBe(1); // only the seed row
  });

  it("aligns mismatched array lengths to the shorter one", async () => {
    await seedConversation();
    mocks.pairs = {
      questions: ["q1", "q2", "q3"],
      answers: ["a1"],
    };
    const stats = await mining.mine();
    expect(stats.extracted).toBe(1);
  });
});
