import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { settings } from "#/config.ts";
import { getChatModel } from "#/core/llm.ts";

const KEYS = [
  "chatThinking",
  "chatReasoningEffort",
  "chatReasoningSplit",
  "chatApiKey",
] as const;

const saved = new Map<string, string>(KEYS.map((k) => [k, settings[k]]));

afterEach(() => {
  for (const k of KEYS) {
    settings[k] = saved.get(k) ?? "";
  }
});

function modelKwargs(): Record<string, unknown> {
  const model = getChatModel();
  return z.record(z.string(), z.unknown()).parse(model.modelKwargs ?? {});
}

describe("thinking-chain kwargs", () => {
  beforeEach(() => {
    settings.chatApiKey = "test-key";
    settings.chatThinking = "";
    settings.chatReasoningEffort = "";
    settings.chatReasoningSplit = "";
  });

  it("sends nothing when all three settings are empty", () => {
    expect(modelKwargs()).toEqual({});
  });

  it("maps chat_thinking into the extra body", () => {
    settings.chatThinking = "disabled";
    expect(modelKwargs()).toEqual({ thinking: { type: "disabled" } });
  });

  it("thinking=false forces an explicit disabled (not merely omitted)", () => {
    // DeepSeek-style upstreams default thinking ON; structured() must send
    // disabled explicitly because thinking and forced tool_choice clash.
    const model = getChatModel({ thinking: false });
    expect(model.modelKwargs).toEqual({ thinking: { type: "disabled" } });
  });

  it("accepts the common truthy spellings for reasoning_split", () => {
    for (const value of ["1", "true", "YES", "On"]) {
      settings.chatReasoningSplit = value;
      expect(modelKwargs().reasoning_split).toBe(true);
    }
    for (const value of ["0", "false", "no", "off"]) {
      settings.chatReasoningSplit = value;
      expect(modelKwargs().reasoning_split).toBe(false);
    }
  });

  it("validates reasoning_effort and ignores junk values", () => {
    settings.chatReasoningEffort = "high";
    expect(modelKwargs().reasoning_effort).toBe("high");
    settings.chatReasoningEffort = "banana";
    expect(modelKwargs()).not.toHaveProperty("reasoning_effort");
  });
});
