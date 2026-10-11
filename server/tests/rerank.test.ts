import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { settings } from "#/config.ts";
import { rerank } from "#/core/rerank.ts";

const saved = {
  baseUrl: settings.rerankBaseUrl,
  protocol: settings.rerankProtocol,
  model: settings.rerankModel,
};

afterEach(() => {
  settings.rerankBaseUrl = saved.baseUrl;
  settings.rerankProtocol = saved.protocol;
  settings.rerankModel = saved.model;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("rerank URL building (jina shape)", () => {
  it.each([
    // with a version segment: append /rerank
    ["https://api.example.cn/v1", "https://api.example.cn/v1/rerank"],
    ["https://api.example.cn/v1/", "https://api.example.cn/v1/rerank"],
    // without one: add /v1, otherwise the upstream answers 404
    ["https://api.example.cn", "https://api.example.cn/v1/rerank"],
    ["https://api.example.cn/", "https://api.example.cn/v1/rerank"],
    // an existing version segment is left alone (Cohere lives under /v2)
    ["https://api.cohere.com/v2", "https://api.cohere.com/v2/rerank"],
  ])("builds %s -> %s", async (base, want) => {
    settings.rerankBaseUrl = base;
    settings.rerankProtocol = "jina";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ results: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await rerank("q", ["a"]);
    expect(fetchMock.mock.calls[0][0]).toBe(want);
  });

  it("is recomputed on every call, not frozen at import time", async () => {
    settings.rerankProtocol = "jina";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(jsonResponse({ results: [] })),
    );
    vi.stubGlobal("fetch", fetchMock);
    settings.rerankBaseUrl = "https://a.example.com/v1";
    await rerank("q", ["a"]);
    settings.rerankBaseUrl = "https://b.example.com/v1";
    await rerank("q", ["a"]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://a.example.com/v1/rerank");
    expect(fetchMock.mock.calls[1][0]).toBe("https://b.example.com/v1/rerank");
  });
});

describe("rerank behaviour", () => {
  it("orders by relevance and truncates to top_n", async () => {
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          jsonResponse({
            results: [
              { index: 0, relevance_score: 0.1 },
              { index: 1, relevance_score: 0.9 },
              { index: 2, relevance_score: 0.5 },
            ],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await rerank("q", ["a", "b", "c"], 2);
    expect(out).toEqual([
      [1, 0.9],
      [2, 0.5],
    ]);
  });

  it("returns [] for empty docs without calling upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await rerank("q", [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a transport failure with backoff", async () => {
    // A dropped connection is transient exactly like a 503: back off and
    // retry instead of bubbling up on the first attempt.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await rerank("q", ["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("retries 429 rate limits", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await rerank("q", ["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("raises after exhausting retries (never a silent empty result)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(rerank("q", ["a"])).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(4); // initial + 3 retries
  }, 30_000);
});

describe("dashscope protocol", () => {
  it("posts the dashscope body shape and reads output.results", async () => {
    settings.rerankProtocol = "dashscope";
    settings.rerankBaseUrl = "https://maas.example.com/compatible-mode/v1";
    const fetchMock = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        Promise.resolve(
          jsonResponse({
            output: {
              results: [{ index: 1, relevance_score: 0.7 }],
            },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await rerank("q", ["a", "b"], 1);
    expect(out).toEqual([[1, 0.7]]);
    const call = z
      .tuple([z.string(), z.object({ body: z.string() })])
      .parse(fetchMock.mock.calls[0]);
    expect(call[0]).toBe(
      "https://maas.example.com/api/v1/services/rerank/text-rerank/text-rerank",
    );
    const body = z
      .object({
        input: z.object({ query: z.string(), documents: z.array(z.string()) }),
        parameters: z.object({ top_n: z.number() }),
      })
      .parse(JSON.parse(call[1].body));
    expect(body.input).toEqual({ query: "q", documents: ["a", "b"] });
    expect(body.parameters.top_n).toBe(1);
  });
});
