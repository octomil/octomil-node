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
  ToolDef,
} from "./responses.js";
import type { TelemetryReporter } from "./telemetry.js";
import {
  ServerApiClient,
  type QueryValue,
} from "./server-api.js";

// ---------------------------------------------------------------------------
// Types (public surface unchanged)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
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
  delta: { role?: string; content?: string; reasoningContent?: string; toolCalls?: ToolCallDelta[] };
  finishReason?: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatThread {
  id: string;
  title?: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ChatTurnRequest {
  input: string;
  inputParts?: unknown[] | null;
  config?: {
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    stop?: string[];
  };
}

export type ChatThreadMessage = Record<string, unknown>;

class ChatApiClient extends ServerApiClient {
  constructor(serverUrl: string, apiKey: string) {
    super({ serverUrl, apiKey });
  }

  async requestJson<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    return super.requestJson<T>(path, init, query);
  }
}

export class ChatThreadsClient {
  constructor(private readonly api: ChatApiClient) {}

  async create(request: {
    model: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ChatThread> {
    return this.api.requestJson<ChatThread>("/api/v1/chat/threads", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async get(threadId: string): Promise<ChatThread> {
    return this.api.requestJson<ChatThread>(
      `/api/v1/chat/threads/${encodeURIComponent(threadId)}`,
      { method: "GET" },
    );
  }

  async list(query?: {
    limit?: number;
    order?: "asc" | "desc";
  }): Promise<ChatThread[]> {
    return this.api.requestJson<ChatThread[]>(
      "/api/v1/chat/threads",
      { method: "GET" },
      query,
    );
  }
}

export class ChatTurnClient {
  constructor(
    private readonly createTurnInternal: (
      threadId: string,
      request: ChatTurnRequest,
    ) => Promise<ChatThreadMessage>,
    private readonly streamTurnInternal: (
      threadId: string,
      request: ChatTurnRequest,
    ) => AsyncGenerator<ChatChunk, void, undefined>,
  ) {}

  async create(
    threadId: string,
    request: ChatTurnRequest,
  ): Promise<ChatThreadMessage> {
    return this.createTurnInternal(threadId, request);
  }

  async *stream(
    threadId: string,
    request: ChatTurnRequest,
  ): AsyncGenerator<ChatChunk, void, undefined> {
    yield* this.streamTurnInternal(threadId, request);
  }
}

// ---------------------------------------------------------------------------
// ChatClient — thin wrapper over ResponsesClient
// ---------------------------------------------------------------------------

export class ChatClient {
  private readonly responses: ResponsesClient;
  private readonly api: ChatApiClient;
  private readonly serverUrl: string;
  private readonly apiKey: string;
  readonly threads: ChatThreadsClient;
  readonly turn: ChatTurnClient;

  constructor(serverUrl: string, apiKey: string, telemetry?: TelemetryReporter | null) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.responses = new ResponsesClient({
      serverUrl,
      apiKey,
      telemetry: telemetry ?? null,
    });
    this.api = new ChatApiClient(serverUrl, apiKey);
    this.threads = new ChatThreadsClient(this.api);
    this.turn = new ChatTurnClient(
      (threadId, request) => this.createTurn(threadId, request),
      (threadId, request) => this.streamTurn(threadId, request),
    );
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
      if (event.type === "reasoning_delta") {
        const chunk: ChatChunk = {
          id: currentId,
          choices: [
            {
              index: 0,
              delta: { reasoningContent: event.delta },
            },
          ],
        };
        yield chunk;
      } else if (event.type === "text_delta") {
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
    const systemMsg = request.messages.find((m) => m.role === "system");
    const nonSystemMessages = request.messages.filter((m) => m.role !== "system");

    // Preserve full multi-turn context by passing all messages as structured input
    const inputItems = nonSystemMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));

    const rr: ResponseRequest = {
      model: request.model,
      input: inputItems.length === 1 && inputItems[0]!.role === "user"
        ? inputItems[0]!.content  // Single user message → simple string
        : inputItems,
    };

    if (systemMsg) rr.instructions = systemMsg.content;
    if (request.tools && request.tools.length > 0) rr.tools = request.tools;
    if (request.maxTokens !== undefined) rr.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) rr.temperature = request.temperature;
    if (request.topP !== undefined) rr.topP = request.topP;
    if (request.stop && request.stop.length > 0) rr.stop = request.stop;

    return rr;
  }

  private toChatCompletion(responseObj: ResponseObj, _request: ChatRequest): ChatCompletion {
    const message: ChatMessage & { toolCalls?: ToolCall[] } = {
      role: "assistant",
      content: "",
    };

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const output of responseObj.output) {
      if (output.type === "reasoning" && output.reasoningContent) {
        message.reasoningContent = output.reasoningContent;
      } else if (output.type === "text" && output.text) {
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

  private async createTurn(
    threadId: string,
    request: ChatTurnRequest,
  ): Promise<ChatThreadMessage> {
    return this.api.requestJson<ChatThreadMessage>(
      `/api/v1/chat/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          threadId,
        }),
      },
    );
  }

  private async *streamTurn(
    threadId: string,
    request: ChatTurnRequest,
  ): AsyncGenerator<ChatChunk, void, undefined> {
    const response = await fetch(
      `${this.serverUrl}/api/v1/chat/threads/${encodeURIComponent(threadId)}/turns`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...request,
          threadId,
          stream: true,
        }),
      },
    );

    if (!response.ok || !response.body) {
      throw new Error(`chat.turn.stream failed: HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");

        if (data && data !== "[DONE]") {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: string;
            content?: string;
          };
          if (parsed.type === "text_delta" && (parsed.delta || parsed.content)) {
            yield {
              id: threadId,
              choices: [
                {
                  index: 0,
                  delta: { content: parsed.delta ?? parsed.content ?? "" },
                },
              ],
            };
          }
          if (parsed.type === "done") {
            yield {
              id: threadId,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finishReason: "stop",
                },
              ],
            };
          }
        }

        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        break;
      }
    }
  }
}
