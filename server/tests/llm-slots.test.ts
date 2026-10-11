import { afterEach, describe, expect, it } from "vitest";

import { settings } from "#/config.ts";
import { needsNonStreamingTools, resolveSlot } from "#/core/llm.ts";

const SLOT_KEYS = [
  "intentModel",
  "intentBaseUrl",
  "intentApiKey",
  "summaryModel",
  "summaryBaseUrl",
  "summaryApiKey",
] as const;

const saved = new Map<(typeof SLOT_KEYS)[number], string>(
  SLOT_KEYS.map((k) => [k, settings[k]]),
);

afterEach(() => {
  for (const k of SLOT_KEYS) {
    settings[k] = saved.get(k) ?? "";
  }
});

describe("resolve_slot", () => {
  it("chat slot reads the chat group", () => {
    expect(resolveSlot("chat")).toEqual([
      settings.chatModel,
      settings.chatBaseUrl,
      settings.chatApiKey,
    ]);
  });

  it("an empty slot fully inherits the chat group", () => {
    settings.intentModel = "";
    settings.intentBaseUrl = "";
    settings.intentApiKey = "";
    expect(resolveSlot("intent")).toEqual([
      settings.chatModel,
      settings.chatBaseUrl,
      settings.chatApiKey,
    ]);
  });

  it("each override applies independently", () => {
    settings.intentModel = "small-model";
    settings.intentBaseUrl = "";
    settings.intentApiKey = "";
    expect(resolveSlot("intent")).toEqual([
      "small-model",
      settings.chatBaseUrl,
      settings.chatApiKey,
    ]);

    settings.summaryBaseUrl = "https://other.example/v1";
    settings.summaryApiKey = "sk-other";
    settings.summaryModel = "";
    expect(resolveSlot("summary")).toEqual([
      settings.chatModel,
      "https://other.example/v1",
      "sk-other",
    ]);
  });
});

describe("needs_non_streaming_tools", () => {
  it("follows the slot model", () => {
    settings.intentModel = "MiniMax-M3";
    expect(needsNonStreamingTools(null, "intent")).toBe(true);
    settings.intentModel = "deepseek-flash";
    expect(needsNonStreamingTools(null, "intent")).toBe(false);
  });

  it("an explicit model wins", () => {
    expect(needsNonStreamingTools("MiniMax-M2.7")).toBe(true);
    expect(needsNonStreamingTools("gpt-4o")).toBe(false);
  });
});
