import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { settings } from "#/config.ts";
import { getChatModel, structured } from "#/core/llm.ts";

type Behavior = "ok" | "none" | "error" | "flaky";

const mocks = vi.hoisted(() => {
  const ctorCalls: Record<string, unknown>[] = [];
  const methods: (string | undefined)[] = [];
  const state: { invokeCount: number; behavior: string; misses: number } = {
    invokeCount: 0,
    behavior: "ok",
    misses: 0,
  };
  return { ctorCalls, methods, state };
});

vi.mock("@langchain/openai", async () => {
  const { RunnableLambda } = await import("@langchain/core/runnables");
  class FakeChatOpenAI {
    temperature: unknown;

    constructor(kwargs: Record<string, unknown>) {
      mocks.ctorCalls.push(kwargs);
      this.temperature = kwargs.temperature;
    }

    withStructuredOutput(
      _schema: unknown,
      opts?: { method?: string },
    ): unknown {
      mocks.methods.push(opts?.method);
      return RunnableLambda.from(async () => {
        await Promise.resolve();
        mocks.state.invokeCount += 1;
        if (mocks.state.behavior === "error") {
          throw new Error("Invalid JSON: arguments corrupted");
        }
        if (mocks.state.behavior === "none") {
          return null;
        }
        if (
          mocks.state.behavior === "flaky" &&
          mocks.state.invokeCount <= mocks.state.misses
        ) {
          return null;
        }
        return { useful: true, reason: "function_calling" };
      });
    }
  }
  return { ChatOpenAI: FakeChatOpenAI };
});

const checkSchema = z.object({
  useful: z.boolean(),
  reason: z.string(),
});

function setBehavior(behavior: Behavior, misses = 0): void {
  mocks.state.behavior = behavior;
  mocks.state.misses = misses;
}

beforeEach(() => {
  mocks.ctorCalls.length = 0;
  mocks.methods.length = 0;
  mocks.state.invokeCount = 0;
  setBehavior("ok");
  settings.chatApiKey = "test-key";
});

describe("structured output pathway", () => {
  it("succeeds on the first try when tool_calls come back", async () => {
    const result = await structured(checkSchema, {
      model: "test-model",
    }).invoke("is the evidence enough");
    expect(checkSchema.parse(result).reason).toBe("function_calling");
    expect(mocks.state.invokeCount).toBe(1); // no extra upstream call on success
  });

  it("retries once on a parse failure, then raises to the caller", async () => {
    setBehavior("error");
    await expect(
      structured(checkSchema, { model: "test-model" }).invoke("x"),
    ).rejects.toThrow();
    expect(mocks.state.invokeCount).toBe(2);
  });

  it("converts a missing tool_calls (null) into an error, never leaks null", async () => {
    // This is the real shape of "no tool_calls": the chain resolves null
    // instead of throwing; passing it through would blow up at the call site.
    setBehavior("none");
    await expect(
      structured(checkSchema, { model: "test-model" }).invoke("x"),
    ).rejects.toThrow(/tool_calls/);
    expect(mocks.state.invokeCount).toBe(2); // one in-kind retry
  });

  it("a flaky channel that misses once still succeeds", async () => {
    setBehavior("flaky", 1);
    const result = await structured(checkSchema, {
      model: "test-model",
    }).invoke("x");
    expect(checkSchema.parse(result).useful).toBe(true);
    expect(mocks.state.invokeCount).toBe(2);
  });

  it("is pinned to function calling as the only pathway", () => {
    structured(checkSchema, { model: "test-model" });
    expect(mocks.methods).toEqual(["functionCalling"]);
  });

  it("streams by default (non-streaming corrupts arguments on some relays)", () => {
    structured(checkSchema, { model: "test-model" });
    expect(mocks.ctorCalls.at(-1)?.streaming).toBe(true);
    structured(checkSchema, { model: "test-model", streaming: false });
    expect(mocks.ctorCalls.at(-1)?.streaming).toBe(false);
  });

  it("flagged model families force non-streaming tool calls", () => {
    structured(checkSchema, { model: "MiniMax-M3" });
    expect(mocks.ctorCalls.at(-1)?.streaming).toBe(false);
    structured(checkSchema, { model: "deepseek-flash" });
    expect(mocks.ctorCalls.at(-1)?.streaming).toBe(true);
  });

  it("passes temperature through (judges need 0)", () => {
    structured(checkSchema, { model: "test-model", temperature: 0 });
    expect(mocks.ctorCalls.at(-1)?.temperature).toBe(0);
    structured(checkSchema, { model: "test-model" });
    expect(mocks.ctorCalls.at(-1)?.temperature).toBe(0.3);
  });
});

describe("get_chat_model defaults", () => {
  it("uses 0.3 unless the caller pins a temperature", () => {
    expect(getChatModel().temperature).toBe(0.3);
    expect(getChatModel({ temperature: 0 }).temperature).toBe(0);
  });
});
