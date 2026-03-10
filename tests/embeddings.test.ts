import { describe, it, expect, vi, beforeEach } from "vitest";
import { embed } from "../src/embeddings.js";
import type { EmbeddingConfig } from "../src/embeddings.js";
import { OctomilError } from "../src/types.js";

function mockFetchResponse(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
}

const VALID_CONFIG: EmbeddingConfig = {
  serverUrl: "https://api.test.com",
  apiKey: "test-key",
};

const SINGLE_RESPONSE = {
  data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
  model: "nomic-embed-text",
  usage: { prompt_tokens: 5, total_tokens: 5 },
};

const BATCH_RESPONSE = {
  data: [
    { embedding: [0.1, 0.2, 0.3], index: 0 },
    { embedding: [0.4, 0.5, 0.6], index: 1 },
  ],
  model: "nomic-embed-text",
  usage: { prompt_tokens: 10, total_tokens: 10 },
};

describe("embed()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws if serverUrl is empty", async () => {
    await expect(
      embed({ serverUrl: "", apiKey: "key" }, "model", "text"),
    ).rejects.toThrow(OctomilError);
  });

  it("throws if apiKey is empty", async () => {
    await expect(
      embed({ serverUrl: "https://x.com", apiKey: "" }, "model", "text"),
    ).rejects.toThrow(OctomilError);
  });

  it("embeds a single string", async () => {
    const mockFetch = mockFetchResponse(SINGLE_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const result = await embed(VALID_CONFIG, "nomic-embed-text", "hello");

    expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(result.model).toBe("nomic-embed-text");
    expect(result.usage.promptTokens).toBe(5);
    expect(result.usage.totalTokens).toBe(5);
  });

  it("embeds a batch of strings", async () => {
    const mockFetch = mockFetchResponse(BATCH_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    const result = await embed(VALID_CONFIG, "nomic-embed-text", [
      "hello",
      "world",
    ]);

    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
    expect(result.embeddings[1]).toEqual([0.4, 0.5, 0.6]);
    expect(result.usage.promptTokens).toBe(10);
  });

  it("sends correct request format", async () => {
    const mockFetch = mockFetchResponse(SINGLE_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    await embed(VALID_CONFIG, "nomic-embed-text", "hello");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.com/api/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Authorization"]).toBe("Bearer test-key");
    expect(JSON.parse(init.body)).toEqual({
      model_id: "nomic-embed-text",
      input: "hello",
    });
  });

  it("strips trailing slashes from serverUrl", async () => {
    const mockFetch = mockFetchResponse(SINGLE_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);

    await embed(
      { serverUrl: "https://api.test.com///", apiKey: "key" },
      "model",
      "text",
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.test.com/api/v1/embeddings");
  });

  it("throws OctomilError on HTTP error", async () => {
    const mockFetch = mockFetchResponse({}, 500);
    vi.stubGlobal("fetch", mockFetch);

    await expect(
      embed(VALID_CONFIG, "nomic-embed-text", "hello"),
    ).rejects.toThrow(OctomilError);
  });

  it("wraps network errors in OctomilError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    await expect(
      embed(VALID_CONFIG, "nomic-embed-text", "hello"),
    ).rejects.toThrow(OctomilError);
  });

  it("passes AbortSignal to fetch", async () => {
    const mockFetch = mockFetchResponse(SINGLE_RESPONSE);
    vi.stubGlobal("fetch", mockFetch);
    const controller = new AbortController();

    await embed(VALID_CONFIG, "nomic-embed-text", "hello", controller.signal);

    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
  });
});
