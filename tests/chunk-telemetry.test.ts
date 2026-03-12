import { describe, it, expect, vi, beforeEach } from "vitest";
import { streamInference } from "../src/streaming.js";
import type { StreamToken, StreamingConfig } from "../src/streaming.js";
import { ResponsesClient } from "../src/responses.js";
import type { ResponseStreamEvent } from "../src/responses.js";
import { ChatClient } from "../src/chat.js";
import type { ChatChunk } from "../src/chat.js";
import type { TelemetryReporter } from "../src/telemetry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTelemetry(): TelemetryReporter {
  return {
    track: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  } as unknown as TelemetryReporter;
}

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

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// streamInference chunk telemetry
// ---------------------------------------------------------------------------

describe("streamInference chunk telemetry", () => {
  const config: StreamingConfig = {
    serverUrl: "https://api.test.com",
    apiKey: "test-key",
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should emit inference.chunk_produced for each token", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "Hello", "done": false}',
      'data: {"token": " world", "done": false}',
      'data: {"done": true, "latency_ms": 100}',
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const telemetry = createMockTelemetry();
    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "phi-4-mini", "Hello", undefined, telemetry)) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(3);
    expect(telemetry.track).toHaveBeenCalledTimes(3);

    expect(telemetry.track).toHaveBeenNthCalledWith(1, "inference.chunk_produced", {
      "model.id": "phi-4-mini",
      "inference.chunk_index": 0,
    });
    expect(telemetry.track).toHaveBeenNthCalledWith(2, "inference.chunk_produced", {
      "model.id": "phi-4-mini",
      "inference.chunk_index": 1,
    });
    expect(telemetry.track).toHaveBeenNthCalledWith(3, "inference.chunk_produced", {
      "model.id": "phi-4-mini",
      "inference.chunk_index": 2,
    });
  });

  it("should not emit telemetry when reporter is null", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "Hello", "done": true}',
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "model", "Hi", undefined, null)) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(1);
    // No telemetry calls — just making sure no error is thrown
  });

  it("should not emit telemetry when reporter is undefined", async () => {
    const mockResponse = makeSSEResponse([
      'data: {"token": "ok", "done": true}',
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "model", "Hi")) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(1);
  });

  it("should skip chunk events for malformed SSE lines", async () => {
    const mockResponse = makeSSEResponse([
      "event: message",
      "data: not-json",
      'data: {"token": "ok", "done": true}',
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    const telemetry = createMockTelemetry();
    const tokens: StreamToken[] = [];
    for await (const tok of streamInference(config, "model", "Hi", undefined, telemetry)) {
      tokens.push(tok);
    }

    expect(tokens).toHaveLength(1);
    expect(telemetry.track).toHaveBeenCalledTimes(1);
    expect(telemetry.track).toHaveBeenCalledWith("inference.chunk_produced", {
      "model.id": "model",
      "inference.chunk_index": 0,
    });
  });
});

// ---------------------------------------------------------------------------
// ResponsesClient chunk telemetry
// ---------------------------------------------------------------------------

describe("ResponsesClient chunk telemetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should emit inference.chunk_produced for text deltas", async () => {
    const sseResponse = makeSSEResponse([
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}',
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}',
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"usage":null}',
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const telemetry = createMockTelemetry();
    const client = new ResponsesClient({
      serverUrl: "https://api.test.com",
      apiKey: "test-key",
      telemetry,
    });

    const events = await collect(client.stream({ model: "gpt-4o", input: "Hi" }));

    // The first chunk has empty content (""), which is falsy so no text_delta event.
    // "Hello" and " world" produce text_delta events.
    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);

    // Telemetry should fire for each text_delta
    expect(telemetry.track).toHaveBeenCalledTimes(2);
    expect(telemetry.track).toHaveBeenNthCalledWith(1, "inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 0,
    });
    expect(telemetry.track).toHaveBeenNthCalledWith(2, "inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 1,
    });
  });

  it("should emit inference.chunk_produced for tool call deltas", async () => {
    const sseResponse = makeSSEResponse([
      'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}],"usage":null}',
      'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"finish_reason":null}],"usage":null}',
      'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":null}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const telemetry = createMockTelemetry();
    const client = new ResponsesClient({
      serverUrl: "https://api.test.com",
      apiKey: "test-key",
      telemetry,
    });

    const events = await collect(client.stream({ model: "gpt-4o", input: "Weather?" }));

    const toolDeltas = events.filter((e) => e.type === "tool_call_delta");
    expect(toolDeltas).toHaveLength(2);

    expect(telemetry.track).toHaveBeenCalledTimes(2);
    expect(telemetry.track).toHaveBeenNthCalledWith(1, "inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 0,
    });
    expect(telemetry.track).toHaveBeenNthCalledWith(2, "inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 1,
    });
  });

  it("should not emit telemetry when reporter is not provided", async () => {
    const sseResponse = makeSSEResponse([
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const client = new ResponsesClient({
      serverUrl: "https://api.test.com",
      apiKey: "test-key",
    });

    const events = await collect(client.stream({ model: "gpt-4o", input: "Hi" }));
    // Should not throw, just no telemetry
    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ChatClient chunk telemetry
// ---------------------------------------------------------------------------

describe("ChatClient chunk telemetry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should emit inference.chunk_produced for each text delta chunk", async () => {
    // ChatClient now delegates to ResponsesClient; empty content deltas are
    // filtered (no text_delta event), and a done event produces a final chunk.
    const sseResponse = makeSSEResponse([
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const telemetry = createMockTelemetry();
    const client = new ChatClient("https://api.test.com", "test-key", telemetry);

    const chunks = await collect(
      client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
    );

    // "Hello" + " world" produce text_delta chunks; done event produces final chunk
    expect(chunks).toHaveLength(3);

    // Telemetry fires for each text_delta (2 deltas)
    expect(telemetry.track).toHaveBeenCalledTimes(2);
    expect(telemetry.track).toHaveBeenNthCalledWith(1, "inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 0,
    });
    expect(telemetry.track).toHaveBeenNthCalledWith(2, "inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 1,
    });
  });

  it("should not emit telemetry when reporter is null", async () => {
    const sseResponse = makeSSEResponse([
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const client = new ChatClient("https://api.test.com", "test-key", null);

    const chunks = await collect(
      client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
    );

    // text_delta chunk + done chunk
    expect(chunks).toHaveLength(2);
    // No errors thrown, just no telemetry
  });

  it("should not emit telemetry when reporter is not provided", async () => {
    const sseResponse = makeSSEResponse([
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const client = new ChatClient("https://api.test.com", "test-key");

    const chunks = await collect(
      client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
    );

    // text_delta chunk + done chunk
    expect(chunks).toHaveLength(2);
  });

  it("should skip chunk events for malformed SSE lines", async () => {
    const sseResponse = makeSSEResponse([
      "event: heartbeat",
      "data: not-valid-json",
      'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      "data: [DONE]",
    ]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

    const telemetry = createMockTelemetry();
    const client = new ChatClient("https://api.test.com", "test-key", telemetry);

    const chunks = await collect(
      client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
    );

    // text_delta chunk + done chunk
    expect(chunks).toHaveLength(2);
    expect(telemetry.track).toHaveBeenCalledTimes(1);
    expect(telemetry.track).toHaveBeenCalledWith("inference.chunk_produced", {
      "model.id": "gpt-4o",
      "inference.chunk_index": 0,
    });
  });
});
