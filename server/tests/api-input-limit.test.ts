import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as ConfigExports from "#/config.ts";
import { provisionTestDatabase } from "#tests/helpers/test-db.ts";

let app: Hono;
let cleanup: () => Promise<void>;
let settings: (typeof ConfigExports)["settings"];

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_input_limit");
  cleanup = prov.cleanup;
  vi.resetModules();
  // Import config AFTER resetModules so the test mutates the same settings
  // instance the freshly imported server modules use.
  ({ settings } = await import("#/config.ts"));
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

afterAll(async () => {
  await cleanup();
});

describe("chat input budget gate", () => {
  it("rejects an oversized message at the door", async () => {
    const huge = "order details ".repeat(2000);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u1", message: huge }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("too long");
  });

  it("the limit follows the configuration", async () => {
    const saved = settings.maxUserInputTokens;
    settings.maxUserInputTokens = 10;
    try {
      const res = await app.request("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: "u1",
          message: "this message clearly exceeds a ten token budget",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      settings.maxUserInputTokens = saved;
    }
  });

  it("still rejects an empty message via the schema", async () => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "u1", message: "" }),
    });
    expect(res.status).toBe(400);
  });
});
