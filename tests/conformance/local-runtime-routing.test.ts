import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponsesClient, type ResponseRequest } from "../../src/index.js";
import type { LocalResponsesRuntime } from "../../src/responses-runtime.js";

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("Contract Conformance: local runtime routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes responses.create through an injected local runtime without using fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be used"));
    const create = vi.fn(async (request: ResponseRequest) => ({
      id: "resp_local_create",
      model: request.model,
      output: [{ type: "text" as const, text: "Hello local" }],
      finishReason: "stop",
    }));
    const runtime: LocalResponsesRuntime = {
      create,
      stream: async function* () {
        throw new Error("not used");
      },
    };

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
      localRuntime: runtime,
    });

    const response = await client.create({
      model: "phi-local",
      input: "Hi",
      instructions: "Be brief.",
    });

    expect(response.id).toBe("resp_local_create");
    expect(create).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes responses.stream through an injected local runtime without using fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be used"));
    const runtime: LocalResponsesRuntime = {
      create: vi.fn(async () => ({
        id: "unused",
        model: "phi-local",
        output: [],
        finishReason: "stop",
      })),
      stream: async function* () {
        yield { type: "text_delta" as const, delta: "Hello" };
        yield {
          type: "done" as const,
          response: {
            id: "resp_local_stream",
            model: "phi-local",
            output: [{ type: "text" as const, text: "Hello" }],
            finishReason: "stop",
          },
        };
      },
    };

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
      localRuntime: runtime,
    });

    const events = [];
    for await (const event of client.stream({
      model: "phi-local",
      input: "Hi",
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to cloud transport when no local runtime is injected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeJsonResponse({
        id: "resp_cloud_create",
        model: "phi-cloud",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello cloud",
            },
            finish_reason: "stop",
          },
        ],
      }),
    );

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
    });

    const response = await client.create({
      model: "phi-cloud",
      input: "Hi",
    });

    expect(response.id).toBe("resp_cloud_create");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("streams from cloud transport when no local runtime is injected", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeSseResponse([
        'data: {"id":"resp_cloud_stream","model":"phi-cloud","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
        'data: {"id":"resp_cloud_stream","model":"phi-cloud","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
      ]),
    );

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
    });

    const events = [];
    for await (const event of client.stream({
      model: "phi-cloud",
      input: "Hi",
    })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: {
        model: "phi-cloud",
        finishReason: "stop",
        output: [{ type: "text", text: "Hello" }],
      },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});
