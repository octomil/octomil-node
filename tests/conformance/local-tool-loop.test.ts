import { describe, expect, it, vi } from "vitest";

import {
  ResponsesClient,
  ToolRunner,
  type ResponseRequest,
} from "../../src/index.js";
import type { LocalResponsesRuntime } from "../../src/responses-runtime.js";

describe("Contract Conformance: local tool loop", () => {
  it("runs a local tool-calling loop on top of responses", async () => {
    const create = vi
      .fn<LocalResponsesRuntime["create"]>()
      .mockResolvedValueOnce({
        id: "resp_1",
        model: "phi-local",
        output: [
          {
            type: "tool_call",
            toolCall: {
              id: "call_1",
              name: "lookup_weather",
              arguments: '{"city":"New York"}',
            },
          },
        ],
        finishReason: "tool_calls",
      })
      .mockResolvedValueOnce({
        id: "resp_2",
        model: "phi-local",
        output: [{ type: "text", text: "72F and sunny" }],
        finishReason: "stop",
      });

    const runtime: LocalResponsesRuntime = {
      create,
      stream: async function* (_request: ResponseRequest) {
        throw new Error("not used");
      },
    };

    const responses = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
      localRuntime: runtime,
    });
    const executor = {
      execute: vi.fn(async () => ({
        toolCallId: "call_1",
        content: '{"temperature":"72F","condition":"sunny"}',
      })),
    };

    const runner = new ToolRunner(responses, executor);
    const response = await runner.run({
      model: "phi-local",
      input: "How is the weather?",
      tools: [
        {
          type: "function",
          function: { name: "lookup_weather" },
        },
      ],
    });

    expect(response.output).toEqual([{ type: "text", text: "72F and sunny" }]);
    expect(executor.execute).toHaveBeenCalledWith({
      id: "call_1",
      name: "lookup_weather",
      arguments: '{"city":"New York"}',
    });
  });
});
