import { describe, expect, it, vi } from "vitest";

import { ResponsesClient, type ResponseRequest } from "../src/responses.js";
import type { LocalResponsesRuntime } from "../src/responses-runtime.js";

describe("ResponsesClient local runtime", () => {
  it("delegates create() to the configured local runtime", async () => {
    const create = vi.fn(async (request: ResponseRequest) => ({
      id: "resp_local",
      model: request.model,
      output: [{ type: "text" as const, text: "Hello local" }],
      finishReason: "stop",
      usage: {
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      },
    }));

    const runtime: LocalResponsesRuntime = {
      create,
      stream: async function* () {
        throw new Error("not used");
      },
    };

    const client = new ResponsesClient({ localRuntime: runtime });
    const response = await client.create({
      model: "phi-local",
      input: "Hi",
      instructions: "Be concise.",
    });

    expect(response.output).toEqual([{ type: "text", text: "Hello local" }]);
    expect(create).toHaveBeenCalledOnce();
    const effectiveRequest = create.mock.calls[0]![0];
    expect(effectiveRequest.instructions).toBeUndefined();
    expect(effectiveRequest.previousResponseId).toBeUndefined();
    expect(effectiveRequest.input).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("chains previousResponseId locally before delegating", async () => {
    const create = vi
      .fn<LocalResponsesRuntime["create"]>()
      .mockResolvedValueOnce({
        id: "resp_1",
        model: "phi-local",
        output: [{ type: "text", text: "First answer" }],
        finishReason: "stop",
      })
      .mockResolvedValueOnce({
        id: "resp_2",
        model: "phi-local",
        output: [{ type: "text", text: "Second answer" }],
        finishReason: "stop",
      });

    const runtime: LocalResponsesRuntime = {
      create,
      stream: async function* () {
        throw new Error("not used");
      },
    };

    const client = new ResponsesClient({ localRuntime: runtime });
    await client.create({ model: "phi-local", input: "Hi" });
    await client.create({
      model: "phi-local",
      input: "Continue",
      previousResponseId: "resp_1",
    });

    expect(create).toHaveBeenCalledTimes(2);
    const chainedRequest = create.mock.calls[1]![0];
    expect(chainedRequest.input).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
      },
      { role: "user", content: "Continue" },
    ]);
  });

  it("delegates stream() to the configured local runtime and preserves final response", async () => {
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
            id: "resp_stream_local",
            model: "phi-local",
            output: [{ type: "text" as const, text: "Hello" }],
            finishReason: "stop",
          },
        };
      },
    };

    const client = new ResponsesClient({ localRuntime: runtime });
    const events = [];
    for await (const event of client.stream({
      model: "phi-local",
      input: "Hi",
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text_delta", delta: "Hello" });
    expect(events[1]).toMatchObject({
      type: "done",
      response: { id: "resp_stream_local" },
    });
  });
});
