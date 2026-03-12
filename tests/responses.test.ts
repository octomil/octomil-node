import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResponsesClient } from "../src/responses.js";
import type {
  ResponseRequest,
  ResponseObj,
  ResponseStreamEvent,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  DoneEvent,
} from "../src/responses.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPTS = { serverUrl: "https://api.test.com", apiKey: "test-key" };

/** Build a mock Response with JSON body (for non-streaming create). */
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

/** Build a mock Response with SSE body (for streaming). */
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

/** Collect all events from an async generator. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

// A standard chat completion response
const COMPLETION_RESPONSE = {
  id: "chatcmpl-abc123",
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "Hello! How can I help you today?",
      },
      finish_reason: "stop",
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 8,
    total_tokens: 18,
  },
};

// A tool-call completion response
const TOOL_CALL_RESPONSE = {
  id: "chatcmpl-tool456",
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
              arguments: '{"city":"London"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: {
    prompt_tokens: 15,
    completion_tokens: 12,
    total_tokens: 27,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResponsesClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---- create() -----------------------------------------------------------

  describe("create()", () => {
    it("sends correct request for string input", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      const result = await client.create({ model: "gpt-4o-mini", input: "Hello" });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/v1/chat/completions");
      expect(init!.method).toBe("POST");
      expect((init!.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");

      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.stream).toBe(false);
      expect(body.messages).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("returns a properly parsed ResponseObj", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      const result = await client.create({ model: "gpt-4o-mini", input: "Hello" });

      expect(result.id).toBe("chatcmpl-abc123");
      expect(result.model).toBe("gpt-4o-mini");
      expect(result.finishReason).toBe("stop");
      expect(result.output).toHaveLength(1);
      expect(result.output[0]!.type).toBe("text");
      expect(result.output[0]!.text).toBe("Hello! How can I help you today?");
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 8,
        totalTokens: 18,
      });
    });

    it("maps instructions to system message", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      await client.create({
        model: "gpt-4o",
        input: "What time is it?",
        instructions: "You are a helpful assistant.",
      });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.messages).toEqual([
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What time is it?" },
      ]);
    });

    it("parses tool call responses", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(TOOL_CALL_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      const result = await client.create({
        model: "gpt-4o",
        input: "What's the weather in London?",
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather for a city",
              parameters: { type: "object", properties: { city: { type: "string" } } },
            },
          },
        ],
      });

      expect(result.finishReason).toBe("tool_calls");
      expect(result.output).toHaveLength(1);
      expect(result.output[0]!.type).toBe("tool_call");
      expect(result.output[0]!.toolCall).toEqual({
        id: "call_abc",
        name: "get_weather",
        arguments: '{"city":"London"}',
      });
    });

    it("chains conversation via previousResponseId", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      // First call — creates the initial response
      const first = await client.create({ model: "gpt-4o-mini", input: "Hello" });
      expect(first.id).toBe("chatcmpl-abc123");

      // Second response for chained call
      const secondResponse = {
        ...COMPLETION_RESPONSE,
        id: "chatcmpl-def456",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Sure, I remember our chat." },
            finish_reason: "stop",
          },
        ],
      };
      fetchSpy.mockResolvedValue(mockJsonResponse(secondResponse));

      // Second call — chains via previousResponseId
      const second = await client.create({
        model: "gpt-4o-mini",
        input: "Do you remember?",
        previousResponseId: "chatcmpl-abc123",
      });

      // Verify second call included previous conversation history
      const body = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
      // Should include: cached messages (user "Hello" + assistant reply) + new user msg
      expect(body.messages).toHaveLength(3);
      expect(body.messages[0]).toEqual({ role: "user", content: "Hello" });
      expect(body.messages[1]).toEqual({
        role: "assistant",
        content: "Hello! How can I help you today?",
      });
      expect(body.messages[2]).toEqual({ role: "user", content: "Do you remember?" });
    });

    it("includes optional parameters in request body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      await client.create({
        model: "gpt-4o",
        input: "Hi",
        maxOutputTokens: 500,
        temperature: 0.7,
        topP: 0.9,
        stop: ["\n"],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.7);
      expect(body.top_p).toBe(0.9);
      expect(body.stop).toEqual(["\n"]);
    });

    it("handles ContentBlock[] input", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);

      await client.create({
        model: "gpt-4o",
        input: [
          { type: "text", text: "What is in this image?" },
          { type: "image", imageUrl: "https://example.com/img.png" },
        ],
      });

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.messages[0].content).toEqual([
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "https://example.com/img.png" } },
      ]);
    });

    it("throws OctomilError on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Unauthorized", { status: 401 }),
      );
      const client = new ResponsesClient(OPTS);

      await expect(
        client.create({ model: "gpt-4o", input: "Hi" }),
      ).rejects.toThrow(OctomilError);
    });

    it("throws OctomilError on network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      const client = new ResponsesClient(OPTS);

      await expect(
        client.create({ model: "gpt-4o", input: "Hi" }),
      ).rejects.toThrow(OctomilError);
    });

    it("strips trailing slashes from serverUrl", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient({
        serverUrl: "https://api.test.com///",
        apiKey: "key",
      });

      await client.create({ model: "gpt-4o", input: "Hi" });

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/v1/chat/completions");
    });
  });

  // ---- stream() -----------------------------------------------------------

  describe("stream()", () => {
    it("yields text_delta events from SSE chunks", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}],"usage":null}',
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}',
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}],"usage":null}',
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        "data: [DONE]",
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const client = new ResponsesClient(OPTS);
      const events = await collect(client.stream({ model: "gpt-4o", input: "Hi" }));

      // Should have: text_delta("Hello"), text_delta(" world"), done
      const textDeltas = events.filter((e): e is TextDeltaEvent => e.type === "text_delta");
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0]!.delta).toBe("Hello");
      expect(textDeltas[1]!.delta).toBe(" world");

      const doneEvents = events.filter((e): e is DoneEvent => e.type === "done");
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]!.response.id).toBe("chatcmpl-s1");
      expect(doneEvents[0]!.response.output).toHaveLength(1);
      expect(doneEvents[0]!.response.output[0]!.text).toBe("Hello world");
      expect(doneEvents[0]!.response.finishReason).toBe("stop");
      expect(doneEvents[0]!.response.usage).toEqual({
        promptTokens: 5,
        completionTokens: 2,
        totalTokens: 7,
      });
    });

    it("yields tool_call_delta events from SSE chunks", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_xyz","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}],"usage":null}',
        'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\""}}]},"finish_reason":null}],"usage":null}',
        'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"London\\"}"}}]},"finish_reason":null}],"usage":null}',
        'data: {"id":"chatcmpl-t1","model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":15,"total_tokens":25}}',
        "data: [DONE]",
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const client = new ResponsesClient(OPTS);
      const events = await collect(client.stream({ model: "gpt-4o", input: "Weather in London?" }));

      const toolDeltas = events.filter(
        (e): e is ToolCallDeltaEvent => e.type === "tool_call_delta",
      );
      expect(toolDeltas).toHaveLength(3);
      expect(toolDeltas[0]!.id).toBe("call_xyz");
      expect(toolDeltas[0]!.name).toBe("get_weather");

      const doneEvents = events.filter((e): e is DoneEvent => e.type === "done");
      expect(doneEvents).toHaveLength(1);

      const toolOutput = doneEvents[0]!.response.output.find((o) => o.type === "tool_call");
      expect(toolOutput).toBeDefined();
      expect(toolOutput!.toolCall!.id).toBe("call_xyz");
      expect(toolOutput!.toolCall!.name).toBe("get_weather");
      expect(toolOutput!.toolCall!.arguments).toBe('{"city":"London"}');
    });

    it("sends stream=true in request body", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}',
        "data: [DONE]",
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const client = new ResponsesClient(OPTS);
      await collect(client.stream({ model: "gpt-4o", input: "Hi" }));

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.stream).toBe(true);
    });

    it("maps instructions to system message in stream", async () => {
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}',
        "data: [DONE]",
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const client = new ResponsesClient(OPTS);
      await collect(
        client.stream({
          model: "gpt-4o",
          input: "Hi",
          instructions: "Be concise.",
        }),
      );

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(body.messages[0]).toEqual({ role: "system", content: "Be concise." });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("chains via previousResponseId in stream", async () => {
      // First call — non-streaming create to populate cache
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(COMPLETION_RESPONSE),
      );
      const client = new ResponsesClient(OPTS);
      const first = await client.create({ model: "gpt-4o-mini", input: "Hello" });

      // Second call — streaming with previousResponseId
      const sseResponse = mockSSEResponse([
        'data: {"id":"chatcmpl-s2","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"I remember!"},"finish_reason":"stop"}],"usage":null}',
        "data: [DONE]",
      ]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      await collect(
        client.stream({
          model: "gpt-4o-mini",
          input: "Do you remember?",
          previousResponseId: first.id,
        }),
      );

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      // Cached conversation: [user "Hello", assistant reply] + new user message
      expect(body.messages).toHaveLength(3);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("Hello");
      expect(body.messages[1].role).toBe("assistant");
      expect(body.messages[2].role).toBe("user");
      expect(body.messages[2].content).toBe("Do you remember?");
    });

    it("throws on empty body", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        body: null,
        headers: new Headers(),
      } as unknown as Response);

      const client = new ResponsesClient(OPTS);
      const gen = client.stream({ model: "gpt-4o", input: "Hi" });
      await expect(gen.next()).rejects.toThrow("empty body");
    });

    it("throws OctomilError on HTTP error in stream", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Server Error", { status: 500 }),
      );

      const client = new ResponsesClient(OPTS);
      const gen = client.stream({ model: "gpt-4o", input: "Hi" });
      await expect(gen.next()).rejects.toThrow(OctomilError);
    });

    it("skips malformed SSE lines gracefully", async () => {
      const sseResponse = mockSSEResponse([
        "event: heartbeat",
        ": comment",
        "data: not-valid-json",
        'data: {"id":"chatcmpl-s1","model":"gpt-4o","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":null}',
        "data: [DONE]",
      ]);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse);

      const client = new ResponsesClient(OPTS);
      const events = await collect(client.stream({ model: "gpt-4o", input: "Hi" }));

      const textDeltas = events.filter((e): e is TextDeltaEvent => e.type === "text_delta");
      expect(textDeltas).toHaveLength(1);
      expect(textDeltas[0]!.delta).toBe("ok");
    });
  });
});
