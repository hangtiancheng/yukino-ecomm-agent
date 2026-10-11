import { describe, expect, it } from "vitest";

import { settings } from "#/config.ts";
import {
  graphCallbacks,
  langfuseConfig,
  langfuseEnabled,
  recordTurn,
  tagIntent,
} from "#/core/observability.ts";

describe("observability degrades to safe no-ops without langfuse config", () => {
  const saved = {
    pk: settings.langfusePublicKey,
    sk: settings.langfuseSecretKey,
    url: settings.langfuseBaseUrl,
  };

  function disable(): void {
    settings.langfusePublicKey = "";
    settings.langfuseSecretKey = "";
    settings.langfuseBaseUrl = "";
  }

  function restore(): void {
    settings.langfusePublicKey = saved.pk;
    settings.langfuseSecretKey = saved.sk;
    settings.langfuseBaseUrl = saved.url;
  }

  it("reports disabled and attaches no callbacks", () => {
    disable();
    try {
      expect(langfuseEnabled()).toBe(false);
      expect(graphCallbacks(1, "u1")).toEqual([]);
      expect(langfuseConfig()).toBeNull();
      // must not throw
      tagIntent("logistics", 0.9);
      recordTurn({ sessionId: 1, input: "x", output: "y", totalTokens: 3 });
    } finally {
      restore();
    }
  });

  it("requires all three keys to enable", () => {
    disable();
    try {
      settings.langfusePublicKey = "pk";
      settings.langfuseSecretKey = "sk";
      expect(langfuseEnabled()).toBe(false);
      settings.langfuseBaseUrl = "http://localhost:3000";
      expect(langfuseEnabled()).toBe(true);
      expect(langfuseConfig()).toEqual({
        publicKey: "pk",
        secretKey: "sk",
        baseUrl: "http://localhost:3000",
      });
      expect(graphCallbacks(7, "u1")).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
