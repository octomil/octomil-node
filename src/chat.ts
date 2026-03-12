/**
 * Chat namespace — low-level chat completion API (Layer 1).
 * Matches SDK_FACADE_CONTRACT.md chat.create() and chat.stream().
 *
 * Sends requests directly to POST /v1/chat/completions and returns
 * OpenAI-compatible ChatCompletion / ChatChunk shapes with camelCase fields.
 */

import { OctomilError } from "./types.js";
import type { ToolDef } from "./responses.js";

// ---------------------------------------------------------------------------
// Types
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
// Wire-format types (snake_case from server)
// ---------------------------------------------------------------------------

interface WireChatCompletion {
  id: string;
  model: string;
  choices: WireChatChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface WireChatChoice {
  index: number;
  message: {
    role: string;
    content?: string | null;
    tool_calls?: WireToolCall[];
  };
  finish_reason: string;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireChatChunk {
  id: string;
  model?: string;
  choices: WireChatChunkChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface WireChatChunkChoice {
  index: number;
  delta: {
    role?: string;
    content?: string | null;
    tool_calls?: WireChunkToolCall[];
  };
  finish_reason: string | null;
}

interface WireChunkToolCall {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

// ---------------------------------------------------------------------------
// ChatClient
// ---------------------------------------------------------------------------

export class ChatClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(serverUrl: string, apiKey: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Create a chat completion (non-streaming).
   */
  async create(request: ChatRequest): Promise<ChatCompletion> {
    const body = this.buildBody(request, false);
    const response = await this.post(body);
    const data = (await response.json()) as WireChatCompletion;
    return this.parseCompletion(data);
  }

  /**
   * Stream a chat completion via SSE.
   */
  async *stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const body = this.buildBody(request, true);
    const response = await this.post(body);

    if (!response.body) {
      throw new OctomilError(
        "Chat streaming response returned empty body",
        "INFERENCE_FAILED",
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const chunk = this.parseSSELine(line);
          if (chunk) yield chunk;
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const chunk = this.parseSSELine(buffer);
        if (chunk) yield chunk;
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---- private helpers ----------------------------------------------------

  private buildBody(
    request: ChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const messages = request.messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.name) msg["name"] = m.name;
      if (m.toolCallId) msg["tool_call_id"] = m.toolCallId;
      return msg;
    });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
    };

    if (request.temperature !== undefined) body["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) body["max_tokens"] = request.maxTokens;
    if (request.topP !== undefined) body["top_p"] = request.topP;
    if (request.stop && request.stop.length > 0) body["stop"] = request.stop;
    if (request.tools && request.tools.length > 0) body["tools"] = request.tools;

    return body;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const url = `${this.serverUrl}/v1/chat/completions`;
    const stream = body["stream"] === true;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          Accept: stream ? "text/event-stream" : "application/json",
          "User-Agent": "octomil-node/1.0",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OctomilError(
        `Chat request failed: ${String(err)}`,
        "NETWORK_UNAVAILABLE",
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        `Chat request failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
        "INFERENCE_FAILED",
      );
    }

    return response;
  }

  private parseCompletion(data: WireChatCompletion): ChatCompletion {
    return {
      id: data.id,
      model: data.model,
      choices: data.choices.map((c) => this.parseChoice(c)),
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }

  private parseChoice(c: WireChatChoice): ChatChoice {
    const message: ChatMessage & { toolCalls?: ToolCall[] } = {
      role: c.message.role as ChatMessage["role"],
      content: c.message.content ?? "",
    };

    if (c.message.tool_calls && c.message.tool_calls.length > 0) {
      message.toolCalls = c.message.tool_calls.map((tc) => ({
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
    }

    return {
      index: c.index,
      message,
      finishReason: c.finish_reason,
    };
  }

  private parseSSELine(line: string): ChatChunk | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return null;

    const dataStr = trimmed.slice(5).trim();
    if (!dataStr || dataStr === "[DONE]") return null;

    let raw: WireChatChunk;
    try {
      raw = JSON.parse(dataStr) as WireChatChunk;
    } catch {
      return null;
    }

    return {
      id: raw.id,
      choices: raw.choices.map((c) => {
        const delta: ChatChunkChoice["delta"] = {};
        if (c.delta.role) delta.role = c.delta.role;
        if (c.delta.content !== undefined && c.delta.content !== null) {
          delta.content = c.delta.content;
        }
        if (c.delta.tool_calls && c.delta.tool_calls.length > 0) {
          delta.toolCalls = c.delta.tool_calls.map((tc) => {
            const d: ToolCallDelta = { index: tc.index };
            if (tc.id) d.id = tc.id;
            if (tc.function) {
              d.function = {};
              if (tc.function.name) d.function.name = tc.function.name;
              if (tc.function.arguments !== undefined) d.function.arguments = tc.function.arguments;
            }
            return d;
          });
        }

        return {
          index: c.index,
          delta,
          finishReason: c.finish_reason ?? undefined,
        };
      }),
      usage: raw.usage
        ? {
            promptTokens: raw.usage.prompt_tokens,
            completionTokens: raw.usage.completion_tokens,
            totalTokens: raw.usage.total_tokens,
          }
        : undefined,
    };
  }
}
