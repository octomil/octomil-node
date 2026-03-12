import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatClient } from "../src/chat.js";
import type {
  ChatCompletion,
  ChatChunk,
  ChatRequest,
} from "../src/chat.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock Response with JSON body (non-streaming). */
function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    body: null,
    headers: new Headers(),
  } as unknown as Response;
}

/** Build a mock Response with SSE body (streaming). */
function mockSSEResponse(lines: string[]): Response {
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

/** Collect all items from an async generator. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

// Wire-format fixtures (snake_case, as the server returns them)

const WIRE_COMPLETION = {
  id: "chatcmpl-abc123",
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello! How can I help?",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 6,
    total_tokens: 16,
  },
};

const WIRE_TOOL_CALL_COMPLETION = {
  id: "chatcmpl-tool789",
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc",
            type: "function" as const,
            function: {
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 15,
    completion_tokens: 20,
    total_tokens: 35,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChatClient", () => {
  let client: ChatClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new ChatClient("https://api.test.com", "test-key");
  });

  // ---- create() -----------------------------------------------------------

  describe("create()", () => {
    it("sends correct request and parses response", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(WIRE_COMPLETION),
      );

      const request: ChatRequest = {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = await client.create(request);

      // Verify fetch call
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/v1/chat/completions");
      expect(init!.method).toBe("POST");

      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);

      // Verify parsed result
      expect(result.id).toBe("chatcmpl-abc123");
      expect(result.model).toBe("gpt-4o-mini");
      expect(result.choices).toHaveLength(1);
      expect(result.choices[0]!.message.role).toBe("assistant");
      expect(result.choices[0]!.message.content).toBe("Hello! How can I help?");
      expect(result.choices[0]!.finishReason).toBe("stop");
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 6,
        totalTokens: 16,
      });
    });

    it("includes optional parameters in request body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(WIRE_COMPLETION),
      );

      await client.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.7,
        maxTokens: 500,
        topP: 0.9,
        stop: ["\n"],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(500);
      expect(body.top_p).toBe(0.9);
      expect(body.stop).toEqual(["\n"]);
    });

    it("includes tools in request body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(WIRE_TOOL_CALL_COMPLETION),
      );

      await client.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.tools).toHaveLength(1);
      expect(body.tools[0].function.name).toBe("get_weather");
    });

    it("parses tool call responses", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(WIRE_TOOL_CALL_COMPLETION),
      );

      const result = await client.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Weather in Paris?" }],
      });

      expect(result.choices[0]!.finishReason).toBe("tool_calls");
      expect(result.choices[0]!.message.toolCalls).toHaveLength(1);
      expect(result.choices[0]!.message.toolCalls![0]!.id).toBe("call_abc");
      expect(result.choices[0]!.message.toolCalls![0]!.function.name).toBe("get_weather");
      expect(result.choices[0]!.message.toolCalls![0]!.function.arguments).toBe('{"city":"Paris"}');
    });

    it("maps message name and toolCallId to wire format", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(WIRE_COMPLETION),
      );

      await client.create({
        model: "gpt-4o",
        messages: [
          { role: "tool", content: '{"temp": 20}', name: "get_weather", toolCallId: "call_abc" },
        ],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.messages[0].name).toBe("get_weather");
      expect(body.messages[0].tool_call_id).toBe("call_abc");
    });

    it("throws OctomilError on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Unauthorized", { status: 401 }),
      );

      await expect(
        client.create({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      ).rejects.toThrow(OctomilError);
    });

    it("throws OctomilError on network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(
        client.create({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      ).rejects.toThrow(OctomilError);
    });

    it("strips trailing slashes from serverUrl", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(WIRE_COMPLETION),
      );
      const c = new ChatClient("https://api.test.com///", "key");

      await c.create({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] });

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/v1/chat/completions");
    });

    it("handles missing usage gracefully", async () => {
      const noUsage = { ...WIRE_COMPLETION, usage: undefined };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(mockJsonResponse(noUsage));

      const result = await client.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.usage).toBeUndefined();
    });
  });

  // ---- stream() -----------------------------------------------------------

  describe("stream()", () => {
    it("yields ChatChunks from SSE", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        "data: [DONE]",
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const chunks = await collect(
        client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      );

      // 4 chunks (the [DONE] line yields nothing)
      expect(chunks).toHaveLength(4);
      expect(chunks[0]!.id).toBe("chatcmpl-s1");
      expect(chunks[1]!.choices[0]!.delta.content).toBe("Hello");
      expect(chunks[2]!.choices[0]!.delta.content).toBe(" world");
      expect(chunks[3]!.choices[0]!.finishReason).toBe("stop");
      expect(chunks[3]!.usage).toEqual({
        promptTokens: 5,
        completionTokens: 2,
        totalTokens: 7,
      });
    });

    it("yields tool call deltas", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-t1","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-t1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"London\\"}"}}]},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-t1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        "data: [DONE]",
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const chunks = await collect(
        client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Weather?" }] }),
      );

      expect(chunks).toHaveLength(4);
      // First chunk has the tool call start
      expect(chunks[0]!.choices[0]!.delta.toolCalls).toHaveLength(1);
      expect(chunks[0]!.choices[0]!.delta.toolCalls![0]!.id).toBe("call_xyz");
      expect(chunks[0]!.choices[0]!.delta.toolCalls![0]!.function?.name).toBe("get_weather");
      // Subsequent chunks have argument deltas
      expect(chunks[1]!.choices[0]!.delta.toolCalls![0]!.function?.arguments).toBe('{"city"');
      expect(chunks[2]!.choices[0]!.delta.toolCalls![0]!.function?.arguments).toBe(':"London"}');
      // Last chunk has finish reason
      expect(chunks[3]!.choices[0]!.finishReason).toBe("tool_calls");
    });

    it("sends stream=true in request body", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      await collect(
        client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      );

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.stream).toBe(true);
    });

    it("throws on empty body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
        headers: new Headers(),
      } as unknown as Response);

      const gen = client.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      });
      await expect(gen.next()).rejects.toThrow("empty body");
    });

    it("throws OctomilError on HTTP error in stream", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Server Error", { status: 500 }),
      );

      const gen = client.stream({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      });
      await expect(gen.next()).rejects.toThrow(OctomilError);
    });

    it("skips malformed SSE lines gracefully", async () => {
      const sseResponse = mockSSEResponse([
        "event: heartbeat",
        ": comment",
        "data: not-valid-json",
        'data: {"id":"chatcmpl-s1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const chunks = await collect(
        client.stream({ model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] }),
      );

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.choices[0]!.delta.content).toBe("ok");
    });
  });
});
