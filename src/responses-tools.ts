import type {
  ResponseInputItem,
  ResponseObj,
  ResponseOutput,
  ResponseRequest,
  ResponseToolCall,
  ResponsesClient,
} from "./responses.js";

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ToolExecutor {
  execute(call: ResponseToolCall): Promise<ToolResult>;
}

function extractToolCalls(output: ResponseOutput[]): ResponseToolCall[] {
  return output
    .filter(
      (item): item is ResponseOutput & { type: "tool_call"; toolCall: ResponseToolCall } =>
        item.type === "tool_call" && !!item.toolCall,
    )
    .map((item) => item.toolCall);
}

function assistantToolCallMessage(
  toolCalls: ResponseToolCall[],
): ResponseInputItem {
  return {
    role: "assistant",
    content: toolCalls.map((toolCall) => ({
      type: "tool_call" as const,
      toolCall,
    })),
  };
}

export class ToolRunner {
  private readonly responses: ResponsesClient;
  private readonly executor: ToolExecutor;
  private readonly maxIterations: number;

  constructor(
    responses: ResponsesClient,
    executor: ToolExecutor,
    maxIterations = 10,
  ) {
    this.responses = responses;
    this.executor = executor;
    this.maxIterations = maxIterations;
  }

  async run(request: ResponseRequest): Promise<ResponseObj> {
    const currentInput = this.normalizeInput(request.input);

    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const response = await this.responses.create({
        ...request,
        input: currentInput,
      });

      const toolCalls = extractToolCalls(response.output);
      if (toolCalls.length === 0) {
        return response;
      }

      currentInput.push(assistantToolCallMessage(toolCalls));

      for (const toolCall of toolCalls) {
        let result: ToolResult;
        try {
          result = await this.executor.execute(toolCall);
        } catch (error) {
          result = {
            toolCallId: toolCall.id,
            content:
              error instanceof Error ? `Error: ${error.message}` : "Error",
            isError: true,
          };
        }

        currentInput.push({
          role: "tool",
          toolCallId: result.toolCallId,
          content: result.content,
        });
      }
    }

    return this.responses.create({
      ...request,
      input: currentInput,
      tools: [],
    });
  }

  private normalizeInput(input: ResponseRequest["input"]): ResponseInputItem[] {
    if (typeof input === "string") {
      return [{ role: "user", content: input }];
    }

    if (input.every((item) => "role" in item)) {
      return input.map((item) => ({ ...item }));
    }

    return [{ role: "user", content: input }];
  }
}
