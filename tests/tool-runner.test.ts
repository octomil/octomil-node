import { describe, expect, it, vi } from "vitest";

import { ToolRunner } from "../src/responses-tools.js";
import { type ResponsesClient } from "../src/responses.js";

describe("ToolRunner", () => {
  it("loops tool calls until the model returns plain text", async () => {
    const create = vi
      .fn<ResponsesClient["create"]>()
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

    const responses = { create } as unknown as ResponsesClient;
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
          function: {
            name: "lookup_weather",
          },
        },
      ],
    });

    expect(response.output).toEqual([{ type: "text", text: "72F and sunny" }]);
    expect(executor.execute).toHaveBeenCalledWith({
      id: "call_1",
      name: "lookup_weather",
      arguments: '{"city":"New York"}',
    });

    const secondRequest = create.mock.calls[1]![0];
    expect(secondRequest.input).toEqual([
      { role: "user", content: "How is the weather?" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            toolCall: {
              id: "call_1",
              name: "lookup_weather",
              arguments: '{"city":"New York"}',
            },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call_1",
        content: '{"temperature":"72F","condition":"sunny"}',
      },
    ]);
  });
});
