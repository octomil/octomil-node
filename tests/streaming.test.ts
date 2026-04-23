import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseSSELine, streamInference } from "../src/streaming.js";
import type { StreamToken, StreamingConfig } from "../src/streaming.js";

// ---------------------------------------------------------------------------
// parseSSELine
// ---------------------------------------------------------------------------

describe("parseSSELine", () => {
  it("should parse a normal token line", () => {
    const token = parseSSELine('data: {"token": "The", "done": false, "provider": "cloud"}');
    expect(token).not.toBeNull();
    expect(token!.token).toBe("The");
    expect(token!.done).toBe(false);
    expect(token!.provider).toBe("cloud");
    expect(token!.latencyMs).toBeUndefined();
    expect(token!.sessionId).toBeUndefined();
  });

  it("should parse a done token line", () => {
    const token = parseSSELine('data: {"done": true, "latency_ms": 1234.5, "session_id": "abc-123"}');
    expect(token).not.toBeNull();
    expect(token!.token).toBe("");
    expect(token!.done).toBe(true);
    expect(token!.latencyMs).toBe(1234.5);
    expect(token!.sessionId).toBe("abc-123");
  });

  it("should return null for empty lines", () => {
    expect(parseSSELine("")).toBeNull();
    expect(parseSSELine("   ")).toBeNull();
  });

  it("should return null for non-data lines", () => {
    expect(parseSSELine("event: message")).toBeNull();
    expect(parseSSELine("id: 1")).toBeNull();
    expect(parseSSELine(": comment")).toBeNull();
  });

  it("should return null for empty data", () => {
    expect(parseSSELine("data:")).toBeNull();
    expect(parseSSELine("data:   ")).toBeNull();
  });

  it("should return null for invalid JSON", () => {
    expect(parseSSELine("data: not-json")).toBeNull();
  });

  it("should handle whitespace around the line", () => {
    const token = parseSSELine('  data: {"token": "x", "done": false}  ');
    expect(token).not.toBeNull();
    expect(token!.token).toBe("x");
  });

  it("should default token to empty string when missing", () => {
    const token = parseSSELine('data: {"done": false}');
    expect(token).not.toBeNull();
    expect(token!.token).toBe("");
    expect(token!.done).toBe(false);
  });

  it("should default done to false when missing", () => {
    const token = parseSSELine('data: {"token": "hi"}');
    expect(token).not.toBeNull();
    expect(token!.done).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// streamInference
// ---------------------------------------------------------------------------

describe("streamInference", () => {
  const config: StreamingConfig = {
    serverUrl: "https://api.test.com",
    apiKey: "test-key",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function makeSSEResponse(lines: string[]): Response {
    const text = lines.join("\n") + "\n";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("should yield StreamToken objects from SSE", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "Hello", "done": false, "provider": "cloud"}',
      'data: {"token": " world", "done": false}',
      'data: {"done": true, "latency_ms": 100.5, "session_id": "s1"}',
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "phi-4-mini", "Hello")) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(3);
    expect(tokens[0]!.token).toBe("Hello");
    expect(tokens[0]!.provider).toBe("cloud");
    expect(tokens[1]!.token).toBe(" world");
    expect(tokens[2]!.done).toBe(true);
    expect(tokens[2]!.latencyMs).toBe(100.5);
    expect(tokens[2]!.sessionId).toBe("s1");
  });

  it("should send correct request for string input", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "ok", "done": true}',
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "phi-4-mini", "test prompt")) {
      tokens.push(tok);
    }

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.test.com/api/v1/inference/stream");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toEqual(expect.objectContaining({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    }));
    const body = JSON.parse(init!.body as string);
    expect(body.model_id).toBe("phi-4-mini");
    expect(body.input_data).toBe("test prompt");
  });

  it("should send messages array input", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "ok", "done": true}',
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const messages = [{ role: "user", content: "hi" }];
    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "model", messages)) {
      tokens.push(tok);
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.messages).toEqual(messages);
    expect(body.input_data).toBeUndefined();
  });

  it("should include parameters when provided", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "ok", "done": true}',
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "model", "hi", { temperature: 0.7 })) {
      tokens.push(tok);
    }

    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.parameters).toEqual({ temperature: 0.7 });
  });

  it("should throw on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const gen = streamInference(config, "model", "hi");
    await expect(gen.next()).rejects.toThrow("HTTP 500");
  });

  it("should throw on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const gen = streamInference(config, "model", "hi");
    await expect(gen.next()).rejects.toThrow("ECONNREFUSED");
  });

  it("should skip malformed SSE lines", async () => {
    const mockResponse = makeSSEResponse([
      "event: message",
      ": comment",
      "data: not-json",
      'data: {"token": "ok", "done": true}',
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "model", "hi")) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.token).toBe("ok");
  });

  it("should strip trailing slash from serverUrl", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "ok", "done": true}',
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const cfg: StreamingConfig = { serverUrl: "https://api.test.com///", apiKey: "k" };
    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(cfg, "m", "hi")) {
      tokens.push(tok);
    }

    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.test.com/api/v1/inference/stream");
  });
});
