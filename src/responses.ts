/**
 * Responses namespace — structured response API (Layer 2).
 * Matches SDK_FACADE_CONTRACT.md responses.create() and responses.stream().
 *
 * Builds OpenAI-compatible /v1/chat/completions requests from a higher-level
 * ResponseRequest shape and maps the results back to a ResponseObj.
 */

import { OctomilError } from "./types.js";
import type { TelemetryReporter } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentBlock {
  type: "text" | "image" | "audio" | "video" | "file";
  text?: string;
  /** Image URL for cloud inference */
  imageUrl?: string;
  /** Base64-encoded binary data */
  data?: string;
  /** MIME type (e.g. "image/png", "audio/wav", "video/mp4") */
  mediaType?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ResponseRequest {
  model: string;
  input: string | ContentBlock[] | Array<{ role: "user" | "assistant"; content: string }>;
  tools?: ToolDef[];
  instructions?: string;
  previousResponseId?: string;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream?: boolean;
  metadata?: Record<string, string>;
}

export interface ResponseOutput {
  type: "text" | "tool_call" | "reasoning";
  text?: string;
  reasoningContent?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
}

export interface ResponseUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ResponseObj {
  id: string;
  model: string;
  output: ResponseOutput[];
  finishReason: string;
  usage?: ResponseUsage;
}

// Stream event types

export interface TextDeltaEvent {
  type: "text_delta";
  delta: string;
}

export interface ToolCallDeltaEvent {
  type: "tool_call_delta";
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}

export interface ReasoningDeltaEvent {
  type: "reasoning_delta";
  delta: string;
}

export interface DoneEvent {
  type: "done";
  response: ResponseObj;
}

export type ResponseStreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ToolCallDeltaEvent
  | DoneEvent;

export interface ResponsesClientOptions {
  serverUrl: string;
  apiKey: string;
  telemetry?: TelemetryReporter | null;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible request/response shapes (internal)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: string | ChatContentPart[];
}

interface ChatContentPart {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionChoice {
  index: number;
  message: {
    role: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChatToolCall[];
  };
  finish_reason: string;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Shape of a streamed SSE chunk from /v1/chat/completions?stream=true */
interface ChatCompletionChunk {
  id: string;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChunkToolCall[];
  };
  finish_reason: string | null;
}

interface ChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

// ---------------------------------------------------------------------------
// In-memory response cache for previousResponseId chaining
// ---------------------------------------------------------------------------

const MAX_CACHE_SIZE = 100;

class ResponseCache {
  private readonly entries = new Map<string, ChatMessage[]>();
  private readonly order: string[] = [];

  set(id: string, messages: ChatMessage[]): void {
    if (this.entries.has(id)) {
      this.entries.set(id, messages);
      return;
    }
    if (this.order.length >= MAX_CACHE_SIZE) {
      const oldest = this.order.shift();
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(id, messages);
    this.order.push(id);
  }

  get(id: string): ChatMessage[] | undefined {
    return this.entries.get(id);
  }
}

// ---------------------------------------------------------------------------
// ResponsesClient
// ---------------------------------------------------------------------------

export class ResponsesClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly telemetry: TelemetryReporter | null;
  private readonly cache = new ResponseCache();

  constructor(options: ResponsesClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.telemetry = options.telemetry ?? null;
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Create a structured response (non-streaming).
   */
  async create(request: ResponseRequest): Promise<ResponseObj> {
    const messages = this.buildMessages(request);
    const body = this.buildRequestBody(request, messages, false);

    const response = await this.post(body);
    const data = (await response.json()) as ChatCompletionResponse;

    const result = this.parseResponse(data);

    // Cache the full conversation for chaining
    const assistantMessage = this.responseToMessage(data);
    this.cache.set(result.id, [...messages, assistantMessage]);

    return result;
  }

  /**
   * Stream a structured response via SSE.
   */
  async *stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent> {
    const messages = this.buildMessages(request);
    const body = this.buildRequestBody(request, messages, true);

    const response = await this.post(body);

    if (!response.body) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "Streaming response returned empty body",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulators for building the final ResponseObj
    let responseId = "";
    let responseModel = "";
    let finishReason = "";
    const outputParts: ResponseOutput[] = [];
    let currentTextContent = "";
    let currentReasoningContent = "";
    const toolCallAccumulators = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    let usage: ResponseUsage | undefined;
    let chunkIndex = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const chunk = this.parseSSEChunk(line);
          if (!chunk) continue;

          responseId = chunk.id || responseId;
          responseModel = chunk.model || responseModel;

          if (chunk.usage) {
            usage = {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            };
          }

          for (const choice of chunk.choices) {
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // Reasoning content delta
            if (choice.delta.reasoning_content) {
              currentReasoningContent += choice.delta.reasoning_content;
              this.telemetry?.track("inference.chunk_produced", {
                "model.id": request.model,
                "inference.chunk_index": chunkIndex,
                locality: "cloud",
              });
              chunkIndex++;
              yield {
                type: "reasoning_delta",
                delta: choice.delta.reasoning_content,
              } satisfies ReasoningDeltaEvent;
            }

            // Text delta
            if (choice.delta.content) {
              currentTextContent += choice.delta.content;
              this.telemetry?.track("inference.chunk_produced", {
                "model.id": request.model,
                "inference.chunk_index": chunkIndex,
                locality: "cloud",
              });
              chunkIndex++;
              yield {
                type: "text_delta",
                delta: choice.delta.content,
              } satisfies TextDeltaEvent;
            }

            // Tool call deltas
            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const acc = toolCallAccumulators.get(tc.index) ?? {
                  id: "",
                  name: "",
                  arguments: "",
                };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments)
                  acc.arguments += tc.function.arguments;
                toolCallAccumulators.set(tc.index, acc);

                this.telemetry?.track("inference.chunk_produced", {
                  "model.id": request.model,
                  "inference.chunk_index": chunkIndex,
                  locality: "cloud",
                });
                chunkIndex++;
                yield {
                  type: "tool_call_delta",
                  index: tc.index,
                  id: tc.id,
                  name: tc.function?.name,
                  argumentsDelta: tc.function?.arguments,
                } satisfies ToolCallDeltaEvent;
              }
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const chunk = this.parseSSEChunk(buffer);
        if (chunk) {
          responseId = chunk.id || responseId;
          responseModel = chunk.model || responseModel;
          for (const choice of chunk.choices) {
            if (choice.finish_reason) finishReason = choice.finish_reason;
            if (choice.delta.content) {
              currentTextContent += choice.delta.content;
              this.telemetry?.track("inference.chunk_produced", {
                "model.id": request.model,
                "inference.chunk_index": chunkIndex,
                locality: "cloud",
              });
              chunkIndex++;
              yield {
                type: "text_delta",
                delta: choice.delta.content,
              } satisfies TextDeltaEvent;
            }
          }
        }
      }

      // Build final output array
      if (currentReasoningContent) {
        outputParts.push({ type: "reasoning", reasoningContent: currentReasoningContent });
      }
      if (currentTextContent) {
        outputParts.push({ type: "text", text: currentTextContent });
      }
      for (const [, acc] of [...toolCallAccumulators.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        outputParts.push({
          type: "tool_call",
          toolCall: { id: acc.id, name: acc.name, arguments: acc.arguments },
        });
      }

      const finalResponse: ResponseObj = {
        id: responseId,
        model: responseModel,
        output: outputParts,
        finishReason: finishReason || "stop",
        usage,
      };

      // Cache conversation for chaining
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: currentTextContent || "",
      };
      this.cache.set(responseId, [...messages, assistantMsg]);

      yield { type: "done", response: finalResponse } satisfies DoneEvent;
    } finally {
      reader.releaseLock();
    }
  }

  // ---- private helpers ----------------------------------------------------

  private buildMessages(request: ResponseRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // System instructions
    if (request.instructions) {
      messages.push({ role: "system", content: request.instructions });
    }

    // previousResponseId — pull cached conversation history
    if (request.previousResponseId) {
      const cached = this.cache.get(request.previousResponseId);
      if (cached) {
        messages.push(...cached);
      }
    }

    // Current user input
    if (typeof request.input === "string") {
      messages.push({ role: "user", content: request.input });
    } else if (
      Array.isArray(request.input) &&
      request.input.length > 0 &&
      "role" in request.input[0]!
    ) {
      // Structured message array from ChatClient multi-turn context
      for (const msg of request.input as Array<{ role: "user" | "assistant"; content: string }>) {
        messages.push({ role: msg.role, content: msg.content });
      }
    } else {
      const parts: ChatContentPart[] = (request.input as ContentBlock[]).map((block) => {
        switch (block.type) {
          case "image":
            if (block.imageUrl) {
              return {
                type: "image_url" as const,
                image_url: { url: block.imageUrl },
              };
            }
            if (block.data && block.mediaType) {
              return {
                type: "image_url" as const,
                image_url: {
                  url: `data:${block.mediaType};base64,${block.data}`,
                },
              };
            }
            return { type: "text" as const, text: "[image: unresolved]" };

          case "audio":
            if (block.data) {
              const format = block.mediaType?.split("/")[1] ?? "wav";
              return {
                type: "input_audio" as const,
                input_audio: { data: block.data, format },
              };
            }
            return { type: "text" as const, text: "[audio: unresolved]" };

          case "video":
            // OpenAI API doesn't have native video support; send as data URI in image_url
            if (block.data && block.mediaType) {
              return {
                type: "image_url" as const,
                image_url: {
                  url: `data:${block.mediaType};base64,${block.data}`,
                },
              };
            }
            return { type: "text" as const, text: "[video: unresolved]" };

          case "file":
            if (block.data && block.mediaType) {
              const mt = block.mediaType.toLowerCase();
              if (mt.startsWith("image/")) {
                return {
                  type: "image_url" as const,
                  image_url: {
                    url: `data:${block.mediaType};base64,${block.data}`,
                  },
                };
              }
              if (mt.startsWith("audio/")) {
                const fmt = mt.split("/")[1] ?? "wav";
                return {
                  type: "input_audio" as const,
                  input_audio: { data: block.data, format: fmt },
                };
              }
            }
            return { type: "text" as const, text: "[file: unsupported]" };

          default:
            return { type: "text" as const, text: block.text ?? "" };
        }
      });
      messages.push({ role: "user", content: parts });
    }

    return messages;
  }

  private buildRequestBody(
    request: ResponseRequest,
    messages: ChatMessage[],
    stream: boolean,
  ): ChatCompletionRequest {
    const body: ChatCompletionRequest = {
      model: request.model,
      messages,
      stream,
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
    }
    if (request.maxOutputTokens !== undefined) {
      body.max_tokens = request.maxOutputTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.topP !== undefined) {
      body.top_p = request.topP;
    }
    if (request.stop && request.stop.length > 0) {
      body.stop = request.stop;
    }

    return body;
  }

  private async post(body: ChatCompletionRequest): Promise<Response> {
    const url = `${this.serverUrl}/v1/chat/completions`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          Accept: body.stream ? "text/event-stream" : "application/json",
          "User-Agent": "octomil-node/1.0",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Responses request failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Responses request failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
      );
    }

    return response;
  }

  private parseResponse(data: ChatCompletionResponse): ResponseObj {
    const choice = data.choices[0];
    const output: ResponseOutput[] = [];

    if (choice?.message.reasoning_content) {
      output.push({ type: "reasoning", reasoningContent: choice.message.reasoning_content });
    }

    if (choice?.message.content) {
      output.push({ type: "text", text: choice.message.content });
    }

    if (choice?.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        output.push({
          type: "tool_call",
          toolCall: {
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        });
      }
    }

    return {
      id: data.id,
      model: data.model,
      output,
      finishReason: choice?.finish_reason ?? "stop",
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  /** Convert a ChatCompletion response to a single assistant message for caching. */
  private responseToMessage(data: ChatCompletionResponse): ChatMessage {
    const choice = data.choices[0];
    return {
      role: "assistant",
      content: choice?.message.content ?? "",
    };
  }

  /** Parse a single SSE line into a ChatCompletionChunk, or null if not a data event. */
  private parseSSEChunk(line: string): ChatCompletionChunk | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;

    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") return null;

    try {
      return JSON.parse(dataStr) as ChatCompletionChunk;
    } catch {
      return null;
    }
  }
}
