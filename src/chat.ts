/**
 * Chat namespace — compatibility shim over ResponsesClient (Layer 1).
 * Matches SDK_FACADE_CONTRACT.md chat.create() and chat.stream().
 *
 * Delegates to ResponsesClient internally, converting between
 * ChatRequest/ChatCompletion and ResponseRequest/ResponseObj formats.
 */

import { ResponsesClient } from "./responses.js";
import type {
  ResponseRequest,
  ResponseObj,
  ResponseStreamEvent,
  ToolDef,
} from "./responses.js";
import type { TelemetryReporter } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Types (public surface unchanged)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  stream?: boolean;
  topP?: number;
  stop?: string[];
}

export interface ChatCompletion {
  id: string;
  model: string;
  choices: ChatChoice[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ChatChoice {
  index: number;
  message: ChatMessage & { toolCalls?: ToolCall[] };
  finishReason: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatChunk {
  id: string;
  choices: ChatChunkChoice[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ChatChunkChoice {
  index: number;
  delta: { role?: string; content?: string; toolCalls?: ToolCallDelta[] };
  finishReason?: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

// ---------------------------------------------------------------------------
// ChatClient — thin wrapper over ResponsesClient
// ---------------------------------------------------------------------------

export class ChatClient {
  private readonly responses: ResponsesClient;

  constructor(serverUrl: string, apiKey: string, telemetry?: TelemetryReporter | null) {
    this.responses = new ResponsesClient({
      serverUrl,
      apiKey,
      telemetry: telemetry ?? null,
    });
  }

  /**
   * Create a chat completion (non-streaming).
   */
  async create(request: ChatRequest): Promise<ChatCompletion> {
    const responseRequest = this.toResponseRequest(request);
    const responseObj = await this.responses.create(responseRequest);
    return this.toChatCompletion(responseObj, request);
  }

  /**
   * Stream a chat completion via SSE.
   */
  async *stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const responseRequest = this.toResponseRequest(request);
    let currentId = "";
    let chunkUsage: ChatChunk["usage"] | undefined;

    for await (const event of this.responses.stream(responseRequest)) {
      if (event.type === "text_delta") {
        const chunk: ChatChunk = {
          id: currentId,
          choices: [
            {
              index: 0,
              delta: { content: event.delta },
            },
          ],
        };
        yield chunk;
      } else if (event.type === "tool_call_delta") {
        const tcDelta: ToolCallDelta = { index: event.index };
        if (event.id) tcDelta.id = event.id;
        if (event.name || event.argumentsDelta) {
          tcDelta.function = {};
          if (event.name) tcDelta.function.name = event.name;
          if (event.argumentsDelta) tcDelta.function.arguments = event.argumentsDelta;
        }

        const chunk: ChatChunk = {
          id: currentId,
          choices: [
            {
              index: 0,
              delta: { toolCalls: [tcDelta] },
            },
          ],
        };
        yield chunk;
      } else if (event.type === "done") {
        currentId = event.response.id;
        if (event.response.usage) {
          chunkUsage = {
            promptTokens: event.response.usage.promptTokens,
            completionTokens: event.response.usage.completionTokens,
            totalTokens: event.response.usage.totalTokens,
          };
        }

        const chunk: ChatChunk = {
          id: event.response.id,
          choices: [
            {
              index: 0,
              delta: {},
              finishReason: event.response.finishReason,
            },
          ],
          usage: chunkUsage,
        };
        yield chunk;
      }
    }
  }

  // ---- private helpers ----------------------------------------------------

  private toResponseRequest(request: ChatRequest): ResponseRequest {
    // Extract system message as instructions
    const systemMsg = request.messages.find((m) => m.role === "system");
    const nonSystemMessages = request.messages.filter((m) => m.role !== "system");

    // Build a single input string from the conversation
    // The last user message becomes the input; prior messages become context
    const lastUserIdx = nonSystemMessages.map((m) => m.role).lastIndexOf("user");
    const lastUserContent = lastUserIdx >= 0
      ? nonSystemMessages[lastUserIdx]!.content
      : nonSystemMessages[nonSystemMessages.length - 1]?.content ?? "";

    const rr: ResponseRequest = {
      model: request.model,
      input: lastUserContent,
    };

    if (systemMsg) rr.instructions = systemMsg.content;
    if (request.tools && request.tools.length > 0) rr.tools = request.tools;
    if (request.maxTokens !== undefined) rr.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) rr.temperature = request.temperature;
    if (request.topP !== undefined) rr.topP = request.topP;
    if (request.stop && request.stop.length > 0) rr.stop = request.stop;

    return rr;
  }

  private toChatCompletion(responseObj: ResponseObj, request: ChatRequest): ChatCompletion {
    const message: ChatMessage & { toolCalls?: ToolCall[] } = {
      role: "assistant",
      content: "",
    };

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const output of responseObj.output) {
      if (output.type === "text" && output.text) {
        textParts.push(output.text);
      } else if (output.type === "tool_call" && output.toolCall) {
        toolCalls.push({
          id: output.toolCall.id,
          type: "function",
          function: {
            name: output.toolCall.name,
            arguments: output.toolCall.arguments,
          },
        });
      }
    }

    message.content = textParts.join("");
    if (toolCalls.length > 0) message.toolCalls = toolCalls;

    return {
      id: responseObj.id,
      model: responseObj.model,
      choices: [
        {
          index: 0,
          message,
          finishReason: responseObj.finishReason,
        },
      ],
      usage: responseObj.usage,
    };
  }
}
