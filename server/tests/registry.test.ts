import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  builtinSpecs,
  defineRawTool,
  getBuiltinSpec,
  permissionFor,
  register,
} from "#/tools/registry.ts";

describe("builtin registry", () => {
  it("registers the core tools and never a builtin query_logistics", async () => {
    // Pin the red line, not the full set: builtin/ is plug-and-play, so an
    // exact-set assertion would fail on any legitimately dropped-in file.
    const names = new Set((await builtinSpecs()).map((s) => s.name));
    for (const core of [
      "query_order",
      "query_product",
      "query_faq",
      "create_ticket",
      "submit_refund",
    ]) {
      expect(names, `missing core tool ${core}`).toContain(core);
    }
    expect(names.has("query_logistics")).toBe(false); // served by MCP
  });

  it("every spec carries the three essentials", async () => {
    const propsSchema = z.object({
      properties: z.record(z.string(), z.unknown()),
    });
    for (const s of await builtinSpecs()) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.jsonSchema).toBeTypeOf("object");
      expect(propsSchema.safeParse(s.jsonSchema).success).toBe(true);
    }
  });

  it("permissions only trust our own write list", async () => {
    const by = new Map((await builtinSpecs()).map((s) => [s.name, s]));
    expect(by.get("create_ticket")?.permission).toBe("write");
    for (const [name, spec] of by) {
      if (name !== "create_ticket") {
        expect(spec.permission, name).toBe("read");
      }
    }
    expect(permissionFor("mcp_random_tool")).toBe("read");
  });

  it("create_ticket hides the injected conversation id from the model", async () => {
    const spec = await getBuiltinSpec("create_ticket");
    expect(spec?.injectConversation).toBe(true);
    const props = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(spec?.jsonSchema).properties;
    expect(props).not.toHaveProperty("conversation_id");
  });

  it("query_order hides the injected user id from the model", async () => {
    const spec = await getBuiltinSpec("query_order");
    expect(spec?.injectUserId).toBe(true);
    const props = z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(spec?.jsonSchema).properties;
    expect(props).not.toHaveProperty("user_id");
  });

  it("query_faq keeps its extended timeout and no retries", async () => {
    const spec = await getBuiltinSpec("query_faq");
    expect(spec?.timeout).toBe(30); // the RAG pipeline is far slower than 5s
    expect(spec?.maxRetries).toBe(0);
  });

  it("a duplicate registration is dropped, first one wins", async () => {
    const existing = (await builtinSpecs())[0];
    if (!existing) {
      throw new Error("no builtin specs registered");
    }
    register(
      defineRawTool({
        name: existing.name,
        description: "dup",
        jsonSchema: { type: "object", properties: {} },
        source: "builtin",
        handler: () => "dup",
      }),
    );
    const kept = await getBuiltinSpec(existing.name);
    expect(kept?.description).not.toBe("dup");
  });
});
