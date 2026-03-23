import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponsesClient } from "../../src/index.js";

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

describe("Contract Conformance: responses cloud routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes responses.create through cloud transport", async () => {
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
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("routes responses.stream through cloud transport", async () => {
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
      response: { id: "resp_cloud_stream" },
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });
});
