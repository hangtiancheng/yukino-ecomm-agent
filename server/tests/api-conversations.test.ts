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
  const prov = await provisionTestDatabase("yukino_conv");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

beforeEach(async () => {
  await db.prisma.$transaction([
    db.prisma.message.deleteMany(),
    db.prisma.conversation.deleteMany(),
  ]);
});

afterAll(async () => {
  await db.closeDb();
  await cleanup();
});

const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.number(),
      preview: z.string(),
      has_summary: z.boolean(),
    }),
  ),
});

const messagesSchema = z.object({
  items: z.array(z.object({ role: z.string(), content: z.string() })),
});

describe("conversations API", () => {
  it("lists conversations newest first with a first-question preview", async () => {
    const c1 = await repository.createConversation("u1");
    await repository.appendMessage(c1, "user", {
      content: "where is order 1001",
    });
    const c2 = await repository.createConversation("u1");
    await repository.appendMessage(c2, "user", {
      content: "how do I choose cat food",
    });

    const res = await app.request("/api/conversations?user_id=u1");
    expect(res.status).toBe(200);
    const body = await readJson(res, listSchema);
    expect(body.items.map((i) => i.id)).toEqual([c2, c1]);
    expect(body.items[0]?.preview).toBe("how do I choose cat food");
  });

  it("requires user_id", async () => {
    const res = await app.request("/api/conversations");
    expect(res.status).toBe(400);
  });

  it("serializes dialog messages", async () => {
    const cid = await repository.createConversation("u1");
    await repository.appendMessage(cid, "user", {
      content: "where is order 1001",
    });
    await repository.appendMessage(cid, "assistant", { content: "on the way" });

    const res = await app.request(`/api/conversations/${cid}/messages`);
    expect(res.status).toBe(200);
    const body = await readJson(res, messagesSchema);
    expect(body.items.map((m) => [m.role, m.content])).toEqual([
      ["user", "where is order 1001"],
      ["assistant", "on the way"],
    ]);
  });

  it("404s for a missing conversation", async () => {
    const res = await app.request("/api/conversations/999999/messages");
    expect(res.status).toBe(404);
  });
});
