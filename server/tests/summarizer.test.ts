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

import type * as SummarizerExports from "#/core/summarizer.ts";
import type * as DbExports from "#/db/client.ts";
import type * as RepositoryExports from "#/db/repository.ts";

const mocks = vi.hoisted(() => ({
  summary: "compressed facts",
  fail: false,
}));

vi.mock("#/core/llm.ts", () => ({
  structured: () =>
    RunnableLambda.from(async () => {
      await Promise.resolve();
      if (mocks.fail) {
        throw new Error("upstream down");
      }
      return { summary: mocks.summary };
    }),
}));

let db: typeof DbExports;
let repository: typeof RepositoryExports;
let summarizer: typeof SummarizerExports;
let admin: Client;
let dbName: string;

const baseUrl = new URL(
  process.env.TEST_DATABASE_URL ?? "postgresql://127.0.0.1:5432/postgres",
);

beforeAll(async () => {
  dbName = `yukino_agent2_summary_test_${Date.now()}_${process.pid}`;
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
  summarizer = await import("#/core/summarizer.ts");
});

beforeEach(async () => {
  mocks.summary = "compressed facts";
  mocks.fail = false;
  await db.prisma.$transaction([
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

async function conversationWithLayer2(): Promise<{
  cid: number;
  boundary: number;
}> {
  const cid = await repository.createConversation("u-sum");
  const ids: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    ids.push(
      await repository.appendMessage(cid, i % 2 === 0 ? "user" : "assistant", {
        content: `message ${i} with some length to it`,
      }),
    );
  }
  const boundary = ids[2]; // first two messages become layer 2
  await repository.updateLayer1From(cid, boundary);
  return { cid, boundary };
}

describe("run_summary", () => {
  it("compresses layer 2 into a new segment and moves the boundary", async () => {
    const { cid, boundary } = await conversationWithLayer2();
    await summarizer.runSummary(cid);
    const conv = await repository.getConversation(cid);
    expect(conv?.summary).toBe("compressed facts");
    expect(conv?.summaryUptoMsgId).toBe(boundary);
    const segments = await db.prisma.conversationSummary.findMany({
      where: { conversationId: cid },
    });
    expect(segments).toHaveLength(1);
    expect(segments[0].fromMsgId).toBe(1);
    expect(segments[0].uptoMsgId).toBe(boundary);
  });

  it("skips when layer 2 is empty (boundary never behind itself)", async () => {
    const cid = await repository.createConversation("u-sum");
    await summarizer.runSummary(cid); // no anchors at all
    const conv = await repository.getConversation(cid);
    expect(conv?.summary).toBeNull();
    expect(await db.prisma.conversationSummary.count()).toBe(0);
  });

  it("aborts without touching the boundary when the model returns empty", async () => {
    const { cid, boundary } = await conversationWithLayer2();
    mocks.summary = "   ";
    await expect(summarizer.runSummary(cid)).rejects.toThrow();
    const conv = await repository.getConversation(cid);
    expect(conv?.summaryUptoMsgId ?? 0).toBe(0); // unchanged
    expect(conv?.summaryUptoMsgId).not.toBe(boundary);
  });

  it("never re-compresses an existing segment (append-only)", async () => {
    const { cid } = await conversationWithLayer2();
    await summarizer.runSummary(cid);
    // second pass with the same anchors: layer 2 is now empty, nothing to do
    await summarizer.runSummary(cid);
    const segments = await db.prisma.conversationSummary.findMany({
      where: { conversationId: cid },
    });
    expect(segments).toHaveLength(1);
  });
});

describe("maybe_schedule_summary", () => {
  it("runs in the background when layer 2 is over budget", async () => {
    const { cid } = await conversationWithLayer2();
    await summarizer.maybeScheduleSummary(cid);
    // background task: poll until the segment lands (or time out)
    for (let i = 0; i < 50; i += 1) {
      const conv = await repository.getConversation(cid);
      if (conv?.summary === "compressed facts") {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("summary was not scheduled");
  });

  it("does nothing for an unknown conversation", async () => {
    await summarizer.maybeScheduleSummary(999_999);
    expect(await db.prisma.conversationSummary.count()).toBe(0);
  });
});
