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
  const prov = await provisionTestDatabase("yukino_actions");
  cleanup = prov.cleanup;
  vi.resetModules();
  db = await import("#/db/client.ts");
  repository = await import("#/db/repository.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

beforeEach(async () => {
  await db.prisma.$transaction([
    db.prisma.ticket.deleteMany(),
    db.prisma.message.deleteMany(),
    db.prisma.conversation.deleteMany(),
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

const ticketSchema = z.object({ ticket_no: z.string(), status: z.string() });

describe("create-ticket action", () => {
  it("writes a ticket and flips the conversation status", async () => {
    const cid = await repository.createConversation("u1");
    const res = await post("/api/actions/create-ticket", {
      conversation_id: cid,
      description: "it arrived broken",
      ticket_type: "complaint",
    });
    expect(res.status).toBe(200);
    const body = await readJson(res, ticketSchema);
    expect(body.ticket_no).toMatch(/^T\d/);
    const tickets = await db.prisma.ticket.findMany();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.ticketType).toBe("complaint");
    const conv = await repository.getConversation(cid);
    expect(conv?.status).toBe("transferred");
  });

  it("rejects an unknown ticket type", async () => {
    const res = await post("/api/actions/create-ticket", {
      conversation_id: 5,
      description: "x",
      ticket_type: "whatever",
    });
    expect(res.status).toBe(400);
  });

  it("404s for a missing conversation", async () => {
    const res = await post("/api/actions/create-ticket", {
      conversation_id: 999999,
      description: "x",
      ticket_type: "inquiry",
    });
    expect(res.status).toBe(404);
  });
});

describe("create-refund action", () => {
  it("writes a refund ticket carrying order id and reason", async () => {
    const cid = await repository.createConversation("u1");
    const res = await post("/api/actions/create-refund", {
      conversation_id: cid,
      order_id: "1001",
      reason: "quality_issue",
    });
    expect(res.status).toBe(200);
    const tickets = await db.prisma.ticket.findMany();
    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.ticketType).toBe("refund");
    expect(tickets[0]?.description).toContain("1001");
    expect(tickets[0]?.description).toContain("quality_issue");
  });

  it("rejects an unknown reason", async () => {
    const res = await post("/api/actions/create-refund", {
      conversation_id: 7,
      order_id: "1001",
      reason: "whatever",
    });
    expect(res.status).toBe(400);
  });
});

describe("resume action", () => {
  it("requires at least one of order_id / confirmed", async () => {
    const res = await post("/api/actions/resume", { conversation_id: 3 });
    expect(res.status).toBe(400);
  });
});
