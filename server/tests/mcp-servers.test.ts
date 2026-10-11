import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const ROOT = path.join(process.cwd());
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const LOGISTICS_PORT = 18101;
const AFTERSALES_PORT = 18102;

const procs: ChildProcess[] = [];

function waitPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.setTimeout(500);
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`MCP server port ${port} not ready in time`));
          return;
        }
        setTimeout(attempt, 250);
      });
      socket.once("timeout", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`MCP server port ${port} not ready in time`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
  );
  return client;
}

const structuredContentSchema = z.looseObject({
  structuredContent: z.record(z.string(), z.unknown()),
});

beforeAll(async () => {
  procs.push(
    spawn(TSX, ["src/mcp-servers/logistics.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(LOGISTICS_PORT) },
      stdio: "ignore",
    }),
    spawn(TSX, ["src/mcp-servers/aftersales.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(AFTERSALES_PORT) },
      stdio: "ignore",
    }),
  );
  await Promise.all([waitPort(LOGISTICS_PORT), waitPort(AFTERSALES_PORT)]);
}, 40_000);

afterAll(() => {
  for (const p of procs) {
    p.kill("SIGTERM");
  }
});

function structuredOf(result: unknown): Record<string, unknown> {
  return structuredContentSchema.parse(result).structuredContent;
}

describe("mcp servers (real subprocesses)", () => {
  it("lists the three tools with descriptions and JSON schemas", async () => {
    const logistics = await connect(LOGISTICS_PORT);
    const aftersales = await connect(AFTERSALES_PORT);
    try {
      const l = await logistics.listTools();
      const a = await aftersales.listTools();
      const by = new Map([...l.tools, ...a.tools].map((t) => [t.name, t]));
      expect([...by.keys()].sort()).toEqual([
        "query_logistics",
        "query_return_status",
        "query_warranty",
      ]);
      for (const tool of by.values()) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema.properties).toBeDefined();
      }
    } finally {
      await logistics.close();
      await aftersales.close();
    }
  }, 30_000);

  it("query_logistics is deterministic per tracking number", async () => {
    const client = await connect(LOGISTICS_PORT);
    try {
      const r1 = await client.callTool({
        name: "query_logistics",
        arguments: { tracking_no: "SF123" },
      });
      const r2 = await client.callTool({
        name: "query_logistics",
        arguments: { tracking_no: "SF123" },
      });
      expect(structuredOf(r1)).toEqual(structuredOf(r2));
      const payload = structuredOf(r1);
      expect(payload.tracking_no).toBe("SF123");
      expect(payload.status_code).toBeTruthy(); // internal code; the client side translates
      expect(payload.carrier_code).toBe("SF-EXP-01");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("aftersales tools return stable mock payloads", async () => {
    const client = await connect(AFTERSALES_PORT);
    try {
      const w1 = await client.callTool({
        name: "query_warranty",
        arguments: { order_id: "1001" },
      });
      const w2 = await client.callTool({
        name: "query_warranty",
        arguments: { order_id: "1001" },
      });
      expect(structuredOf(w1)).toEqual(structuredOf(w2));
      expect(structuredOf(w1).order_id).toBe("1001");
      expect(["IN_WARRANTY", "EXPIRED"]).toContain(
        structuredOf(w1).warranty_code,
      );

      const r = await client.callTool({
        name: "query_return_status",
        arguments: { order_id: "1001" },
      });
      expect(structuredOf(r).order_id).toBe("1001");
      expect(["AUDITING", "RETURNING", "REFUNDED", "NONE"]).toContain(
        structuredOf(r).return_code,
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
