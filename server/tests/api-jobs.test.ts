import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type * as JobsExports from "#/core/jobs.ts";
import { readJson } from "#tests/helpers/json.ts";
import { provisionTestDatabase } from "#tests/helpers/test-db.ts";

let app: Hono;
let jobs: typeof JobsExports;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const prov = await provisionTestDatabase("yukino_jobs");
  cleanup = prov.cleanup;
  vi.resetModules();
  jobs = await import("#/core/jobs.ts");
  const { createApp } = await import("#/server.ts");
  app = createApp();
});

afterAll(async () => {
  delete jobs.JOBS["test-sleep"];
  await cleanup();
});

const listSchema = z.object({
  jobs: z.array(z.object({ name: z.string(), cmd: z.string() })),
});
const statusSchema = z.object({ status: z.string() });

describe("jobs API security boundary", () => {
  it("rejects any name outside the registry with 404", async () => {
    for (const [path, method] of [
      ["/api/jobs/rm%20-rf", "POST"],
      ["/api/jobs/rm%20-rf", "GET"],
      ["/api/jobs/not-registered/stop", "POST"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, path).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("detail");
    }
  });

  it("GET /api/jobs covers exactly the registry", async () => {
    const res = await app.request("/api/jobs");
    expect(res.status).toBe(200);
    const body = await readJson(res, listSchema);
    expect(new Set(body.jobs.map((j) => j.name))).toEqual(
      new Set(Object.keys(jobs.JOBS)),
    );
    for (const j of body.jobs) {
      expect(j.cmd.length).toBeGreaterThan(0);
    }
  });

  it("refuses re-entry while the same job is running, and can stop it", async () => {
    jobs.JOBS["test-sleep"] = {
      name: "test-sleep",
      title: "test sleep",
      argv: ["sleep", "30"],
      needs: "nothing",
      heavy: false,
    };
    const started = await app.request("/api/jobs/test-sleep", {
      method: "POST",
    });
    expect(started.status).toBe(200);
    expect((await readJson(started, statusSchema)).status).toBe("running");

    const again = await app.request("/api/jobs/test-sleep", { method: "POST" });
    expect(again.status).toBe(409);
    expect(await again.text()).toContain("already running");

    const stopped = await app.request("/api/jobs/test-sleep/stop", {
      method: "POST",
    });
    expect(stopped.status).toBe(200);
    expect((await readJson(stopped, statusSchema)).status).toBe("stopped");
  }, 20_000);

  it("stopping an idle job is a 409", async () => {
    jobs.JOBS["test-sleep"] ??= {
      name: "test-sleep",
      title: "test sleep",
      argv: ["sleep", "30"],
      needs: "nothing",
      heavy: false,
    };
    const res = await app.request("/api/jobs/test-sleep/stop", {
      method: "POST",
    });
    expect(res.status).toBe(409);
  });
});
