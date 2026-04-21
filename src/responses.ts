/**
 * Responses namespace — structured response API (Layer 2).
 * Matches SDK_FACADE_CONTRACT.md responses.create() and responses.stream().
 *
 * Supports both cloud-backed chat completions and an injected local runtime.
 */

import { performance } from "node:perf_hooks";

import { OctomilError } from "./types.js";
import type { TelemetryReporter } from "./telemetry.js";
import type {
  LocalResponsesRuntime,
  LocalResponsesRuntimeResolver,
} from "./responses-runtime.js";
import {
  CandidateAttemptRunner,
  type CandidatePlan,
  type RuntimeChecker,
} from "./runtime/routing/attempt-runner.js";
import {
  RequestRouter,
  type RouteMetadata,
} from "./runtime/routing/request-router.js";
import type { PlannerClient } from "./runtime/routing/planner-client.js";
import type { RouteEvent } from "./runtime/routing/route-event.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentBlock {
  type: "text" | "image" | "audio" | "video" | "file";
  text?: string;
  imageUrl?: string;
  data?: string;
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

export interface ResponseToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ResponseOutput {
  type: "text" | "tool_call" | "reasoning";
  text?: string;
  reasoningContent?: string;
  toolCall?: ResponseToolCall;
}

export interface ResponseInputItem {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentBlock[] | ResponseOutput[] | null;
  toolCallId?: string;
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

export interface ResponseRequest {
  model: string;
  input: string | ContentBlock[] | ResponseInputItem[];
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
  serverUrl?: string;
  apiKey?: string;
  telemetry?: TelemetryReporter | null;
  localRuntime?: LocalResponsesRuntime | LocalResponsesRuntimeResolver | null;
  /** Planner client for fetching runtime plans from the server. */
  plannerClient?: PlannerClient | null;
  /** External endpoint URL for local serve instances. */
  externalEndpoint?: string;
}

/** Route metadata attached to a ResponseObj when planner routing is used. */
export interface ResponseRouteInfo {
  routeMetadata: RouteMetadata;
  routeEvent?: RouteEvent;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible request/response shapes (internal)
// ---------------------------------------------------------------------------

interface ChatContentPart {
  type: "text" | "image_url" | "input_audio";
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  stream: boolean;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
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
// ResponsesClient
// ---------------------------------------------------------------------------

export class ResponsesClient {
  private readonly serverUrl: string;
  private readonly apiKey: string | undefined;
  private readonly telemetry: TelemetryReporter | null;
  private readonly localRuntime:
    | LocalResponsesRuntime
    | LocalResponsesRuntimeResolver
    | null;
  private readonly plannerClient: PlannerClient | null;
  private readonly requestRouter: RequestRouter | null;
  private readonly responseCache = new Map<string, ResponseObj>();
  private readonly messageCache = new Map<string, ResponseInputItem[]>();
  private readonly maxCache = 100;

  /** Route info from the last completed request (for telemetry/inspection). */
  lastRouteInfo: ResponseRouteInfo | null = null;

  constructor(options: ResponsesClientOptions = {}) {
    this.serverUrl = (options.serverUrl ?? "https://api.octomil.com").replace(
      /\/+$/,
      "",
    );
    this.apiKey = options.apiKey;
    this.telemetry = options.telemetry ?? null;
    this.localRuntime = options.localRuntime ?? null;
    this.plannerClient = options.plannerClient ?? null;

    // Build RequestRouter when planner is configured
    if (this.plannerClient) {
      this.requestRouter = new RequestRouter({
        cloudEndpoint: this.serverUrl,
        apiKey: this.apiKey,
        externalEndpoint: options.externalEndpoint,
      });
    } else {
      this.requestRouter = null;
    }
  }

  async create(request: ResponseRequest): Promise<ResponseObj> {
    // ---------------------------------------------------------------
    // Planner-routed path: fetch plan and execute via attempt runner
    // ---------------------------------------------------------------
    if (this.plannerClient && this.requestRouter) {
      return this.createWithPlanner(request);
    }

    // ---------------------------------------------------------------
    // Legacy path: local runtime fallback or direct cloud
    // ---------------------------------------------------------------
    const localRuntime = this.resolveLocalRuntime(request.model);
    if (!localRuntime) {
      return this.createCloud(request);
    }

    const runner = new CandidateAttemptRunner({
      fallbackAllowed: this.cloudFallbackAllowed(request),
    });
    const result = await runner.runWithInference<ResponseObj>(
      this.responseCandidates(localRuntime),
      {
        runtimeChecker: this.responseRuntimeChecker(localRuntime),
        executeCandidate: async (candidate) => {
          if (candidate.locality === "local") {
            return this.createLocal(request, localRuntime);
          }
          return this.createCloud(request);
        },
      },
    );

    if (result.selectedAttempt && result.value) {
      return result.value;
    }
    throw (
      result.error ??
      new OctomilError("INFERENCE_FAILED", "No response route succeeded")
    );
  }

  /**
   * Planner-routed create: fetch a plan, resolve routing, execute via
   * CandidateAttemptRunner.runWithInference with per-candidate execution.
   */
  private async createWithPlanner(request: ResponseRequest): Promise<ResponseObj> {
    const plan = await this.plannerClient!.getPlan({
      model: request.model,
      capability: "responses",
      streaming: false,
      routing_policy: request.metadata?.routing_policy ?? request.metadata?.routingPolicy,
    });

    // Resolve routing (with or without plan)
    const decision = this.requestRouter!.resolve({
      model: request.model,
      capability: "responses",
      streaming: false,
      plannerResult: plan ?? undefined,
      routingPolicy: request.metadata?.routing_policy ?? request.metadata?.routingPolicy,
    });

    const candidates = plan?.candidates ?? [
      { locality: "cloud" as const, engine: "cloud", priority: 0, confidence: 1, reason: "direct cloud" },
    ];

    const localRuntime = this.resolveLocalRuntime(request.model);
    const runner = new CandidateAttemptRunner({
      fallbackAllowed: plan?.fallback_allowed ?? true,
    });

    const result = await runner.runWithInference<ResponseObj>(candidates, {
      runtimeChecker: this.requestRouter!["buildRuntimeChecker"]("responses"),
      executeCandidate: async (candidate) => {
        if (candidate.locality === "local" && localRuntime) {
          return this.createLocal(request, localRuntime);
        }
        return this.createCloud(request);
      },
    });

    // Attach route info for telemetry
    this.lastRouteInfo = {
      routeMetadata: decision.routeMetadata,
      routeEvent: decision.routeMetadata.routeEvent,
    };

    // Emit route event via telemetry
    if (this.telemetry && decision.routeMetadata.routeEvent) {
      this.telemetry.track("route.completed", decision.routeMetadata.routeEvent as unknown as Record<string, unknown>);
    }

    if (result.selectedAttempt && result.value) {
      return result.value;
    }
    throw (
      result.error ??
      new OctomilError("INFERENCE_FAILED", "No response route succeeded (planner path)")
    );
  }

  private async createCloud(request: ResponseRequest): Promise<ResponseObj> {
    const effectiveRequest = this.buildEffectiveRequest(request);
    const body = this.buildRequestBody(effectiveRequest, false);
    this.telemetry?.track("inference.started", {
      "model.id": request.model,
      locality: "cloud",
      method: "responses.create",
    });

    const start = performance.now();
    const response = await this.post(body);
    const data = (await response.json()) as ChatCompletionResponse;
    const result = this.parseResponse(data);
    this.cacheResponse(result);
    this.cacheMessages(result.id, [
      ...this.normalizeInput(effectiveRequest.input),
      this.responseToAssistantInput(result),
    ]);
    this.telemetry?.track("inference.completed", {
      "model.id": request.model,
      "inference.duration_ms": performance.now() - start,
      locality: "cloud",
      method: "responses.create",
    });

    return result;
  }

  async *stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent> {
    // ---------------------------------------------------------------
    // Planner-routed streaming path
    // ---------------------------------------------------------------
    if (this.plannerClient && this.requestRouter) {
      yield* this.streamWithPlanner(request);
      return;
    }

    // ---------------------------------------------------------------
    // Legacy path
    // ---------------------------------------------------------------
    const localRuntime = this.resolveLocalRuntime(request.model);
    if (!localRuntime) {
      yield* this.streamCloud(request);
      return;
    }

    const runner = new CandidateAttemptRunner({
      fallbackAllowed: this.cloudFallbackAllowed(request),
      streaming: true,
    });
    const candidates = this.responseCandidates(localRuntime);
    const readiness = runner.run(candidates, {
      runtimeChecker: this.responseRuntimeChecker(localRuntime),
    });
    const selected = readiness.selectedAttempt;
    if (!selected) {
      throw new OctomilError("INFERENCE_FAILED", "No response route succeeded");
    }

    if (selected.locality === "cloud") {
      yield* this.streamCloud(request);
      return;
    }

    let firstOutputEmitted = false;
    try {
      for await (const event of this.streamLocal(request, localRuntime)) {
        if (event.type !== "done") {
          firstOutputEmitted = true;
        }
        yield event;
      }
    } catch (error) {
      if (
        runner.shouldFallbackAfterInferenceError(firstOutputEmitted) &&
        candidates.some((candidate) => candidate.locality === "cloud")
      ) {
        yield* this.streamCloud(request);
        return;
      }
      throw error;
    }
  }

  /**
   * Planner-routed streaming: fetch plan, evaluate readiness, execute
   * the selected candidate with streaming-aware fallback semantics.
   *
   * No fallback after first streamed token/chunk.
   */
  private async *streamWithPlanner(
    request: ResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    const plan = await this.plannerClient!.getPlan({
      model: request.model,
      capability: "responses",
      streaming: true,
      routing_policy: request.metadata?.routing_policy ?? request.metadata?.routingPolicy,
    });

    const decision = this.requestRouter!.resolve({
      model: request.model,
      capability: "responses",
      streaming: true,
      plannerResult: plan ?? undefined,
      routingPolicy: request.metadata?.routing_policy ?? request.metadata?.routingPolicy,
    });

    const candidates = plan?.candidates ?? [
      { locality: "cloud" as const, engine: "cloud", priority: 0, confidence: 1, reason: "direct cloud" },
    ];

    const fallbackAllowed = plan?.fallback_allowed ?? true;
    const localRuntime = this.resolveLocalRuntime(request.model);

    // Evaluate readiness for each candidate; find the first viable one
    const runner = new CandidateAttemptRunner({
      fallbackAllowed,
      streaming: true,
    });
    const readiness = runner.run(candidates, {
      runtimeChecker: this.requestRouter!["buildRuntimeChecker"]("responses"),
    });

    const selected = readiness.selectedAttempt;
    if (!selected) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "No response route succeeded (planner streaming path)",
      );
    }

    // Attach route info
    this.lastRouteInfo = {
      routeMetadata: decision.routeMetadata,
      routeEvent: decision.routeMetadata.routeEvent,
    };

    // Execute the selected candidate
    if (selected.locality === "local" && localRuntime) {
      let firstOutputEmitted = false;
      try {
        for await (const event of this.streamLocal(request, localRuntime)) {
          if (event.type !== "done") {
            firstOutputEmitted = true;
          }
          yield event;
        }
      } catch (error) {
        // Streaming no-fallback-after-first-token rule
        if (
          !firstOutputEmitted &&
          fallbackAllowed &&
          candidates.some((c) => c.locality === "cloud")
        ) {
          yield* this.streamCloud(request);
          return;
        }
        throw error;
      }
    } else {
      yield* this.streamCloud(request);
    }

    // Emit route event
    if (this.telemetry && decision.routeMetadata.routeEvent) {
      this.telemetry.track("route.completed", decision.routeMetadata.routeEvent as unknown as Record<string, unknown>);
    }
  }

  private async *streamCloud(
    request: ResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    const effectiveRequest = this.buildEffectiveRequest(request);
    const body = this.buildRequestBody(effectiveRequest, true);
    this.telemetry?.track("inference.started", {
      "model.id": request.model,
      locality: "cloud",
      method: "responses.stream",
    });

    const start = performance.now();
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
    let responseId = "";
    let responseModel = request.model;
    let finishReason = "stop";
    const outputParts: ResponseOutput[] = [];
    let currentTextContent = "";
    let currentReasoningContent = "";
    const toolCallAccumulators = new Map<
      number,
      { id?: string; name?: string; arguments: string }
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

            if (choice.delta.reasoning_content) {
              currentReasoningContent += choice.delta.reasoning_content;
              this.telemetry?.track("inference.chunk_produced", {
                "model.id": request.model,
                "inference.chunk_index": chunkIndex++,
                locality: "cloud",
              });
              yield {
                type: "reasoning_delta",
                delta: choice.delta.reasoning_content,
              };
            }

            if (choice.delta.content) {
              currentTextContent += choice.delta.content;
              this.telemetry?.track("inference.chunk_produced", {
                "model.id": request.model,
                "inference.chunk_index": chunkIndex++,
                locality: "cloud",
              });
              yield {
                type: "text_delta",
                delta: choice.delta.content,
              };
            }

            if (choice.delta.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const acc = toolCallAccumulators.get(tc.index) ?? {
                  arguments: "",
                };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) {
                  acc.arguments += tc.function.arguments;
                }
                toolCallAccumulators.set(tc.index, acc);

                this.telemetry?.track("inference.chunk_produced", {
                  "model.id": request.model,
                  "inference.chunk_index": chunkIndex++,
                  locality: "cloud",
                });
                yield {
                  type: "tool_call_delta",
                  index: tc.index,
                  id: tc.id,
                  name: tc.function?.name,
                  argumentsDelta: tc.function?.arguments,
                };
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (currentReasoningContent) {
      outputParts.push({
        type: "reasoning",
        reasoningContent: currentReasoningContent,
      });
    }
    if (currentTextContent) {
      outputParts.push({ type: "text", text: currentTextContent });
    }
    for (const [, acc] of [...toolCallAccumulators.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      outputParts.push({
        type: "tool_call",
        toolCall: {
          id: acc.id ?? generateId(),
          name: acc.name ?? "",
          arguments: acc.arguments,
        },
      });
    }

    const finalResponse: ResponseObj = {
      id: responseId || generateId(),
      model: responseModel,
      output: outputParts,
      finishReason: finishReason || "stop",
      usage,
    };

    this.cacheResponse(finalResponse);
    this.cacheMessages(finalResponse.id, [
      ...this.normalizeInput(effectiveRequest.input),
      this.responseToAssistantInput(finalResponse),
    ]);
    this.telemetry?.track("inference.completed", {
      "model.id": request.model,
      "inference.duration_ms": performance.now() - start,
      locality: "cloud",
      method: "responses.stream",
    });

    yield { type: "done", response: finalResponse };
  }

  private responseCandidates(
    localRuntime: LocalResponsesRuntime | null,
  ): CandidatePlan[] {
    const candidates: CandidatePlan[] = [];
    if (localRuntime) {
      candidates.push({
        locality: "local",
        engine: "localRuntime",
        priority: 0,
        confidence: 1,
        reason: "configured local responses runtime",
      });
    }
    candidates.push({
      locality: "cloud",
      engine: "cloud",
      priority: candidates.length,
      confidence: 1,
      reason: "hosted gateway",
    });
    return candidates;
  }

  private responseRuntimeChecker(
    localRuntime: LocalResponsesRuntime | null,
  ): RuntimeChecker {
    return {
      check: (_engine, locality) => {
        if (locality === "cloud") {
          return { available: true };
        }
        return localRuntime
          ? { available: true }
          : { available: false, reasonCode: "local_runtime_unavailable" };
      },
    };
  }

  private cloudFallbackAllowed(request: ResponseRequest): boolean {
    const policy =
      request.metadata?.routing_policy ?? request.metadata?.routingPolicy;
    return policy !== "private" && policy !== "local_only";
  }

  private resolveLocalRuntime(model: string): LocalResponsesRuntime | null {
    if (!this.localRuntime) return null;
    if (typeof this.localRuntime === "function") {
      return this.localRuntime(model) ?? null;
    }
    return this.localRuntime;
  }

  private async createLocal(
    request: ResponseRequest,
    localRuntime: LocalResponsesRuntime,
  ): Promise<ResponseObj> {
    const effectiveRequest = this.buildEffectiveRequest(request);
    this.telemetry?.track("inference.started", {
      "model.id": request.model,
      locality: "local",
      method: "responses.create",
    });
    const start = performance.now();

    try {
      const response = await localRuntime.create(effectiveRequest);
      this.cacheResponse(response);
      this.telemetry?.track("inference.completed", {
        "model.id": request.model,
        "inference.duration_ms": performance.now() - start,
        locality: "local",
        method: "responses.create",
      });
      return response;
    } catch (error) {
      this.telemetry?.track("inference.failed", {
        "model.id": request.model,
        "error.type": "local_runtime_error",
        locality: "local",
        method: "responses.create",
      });
      throw error;
    }
  }

  private async *streamLocal(
    request: ResponseRequest,
    localRuntime: LocalResponsesRuntime,
  ): AsyncGenerator<ResponseStreamEvent> {
    const effectiveRequest = this.buildEffectiveRequest(request);
    this.telemetry?.track("inference.started", {
      "model.id": request.model,
      locality: "local",
      method: "responses.stream",
    });
    const start = performance.now();
    let chunkIndex = 0;

    try {
      for await (const event of localRuntime.stream(effectiveRequest)) {
        if (event.type === "done") {
          this.cacheResponse(event.response);
          this.telemetry?.track("inference.completed", {
            "model.id": request.model,
            "inference.duration_ms": performance.now() - start,
            locality: "local",
            method: "responses.stream",
          });
        } else {
          this.telemetry?.track("inference.chunk_produced", {
            "model.id": request.model,
            "inference.chunk_index": chunkIndex++,
            locality: "local",
          });
        }
        yield event;
      }
    } catch (error) {
      this.telemetry?.track("inference.failed", {
        "model.id": request.model,
        "error.type": "local_runtime_error",
        locality: "local",
        method: "responses.stream",
      });
      throw error;
    }
  }

  private buildEffectiveRequest(request: ResponseRequest): ResponseRequest {
    const input = this.normalizeInput(request.input);

    if (request.previousResponseId) {
      const previousMessages = this.messageCache.get(request.previousResponseId);
      if (previousMessages) {
        input.unshift(...previousMessages.map((item) => ({ ...item })));
      } else {
        const previous = this.responseCache.get(request.previousResponseId);
        if (previous) {
          input.unshift({
            role: "assistant",
            content: previous.output,
          });
        }
      }
    }

    if (request.instructions) {
      input.unshift({
        role: "system",
        content: request.instructions,
      });
    }

    return {
      ...request,
      input,
      instructions: undefined,
      previousResponseId: undefined,
    };
  }

  private buildRequestBody(
    request: ResponseRequest,
    stream: boolean,
  ): ChatCompletionRequest {
    return {
      model: request.model,
      messages: this.buildMessages(request),
      stream,
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: tool.function,
      })),
      max_tokens: request.maxOutputTokens,
      temperature: request.temperature,
      top_p: request.topP,
      stop: request.stop,
    };
  }

  private buildMessages(request: ResponseRequest): Array<Record<string, unknown>> {
    const input = this.normalizeInput(request.input);
    return input.map((item) => this.inputItemToMessage(item));
  }

  private normalizeInput(input: ResponseRequest["input"]): ResponseInputItem[] {
    if (typeof input === "string") {
      return [{ role: "user", content: input }];
    }

    if (this.isResponseInputItems(input)) {
      return input.map((item) => ({ ...item }));
    }

    return [{ role: "user", content: input }];
  }

  private isResponseInputItems(
    input: ContentBlock[] | ResponseInputItem[],
  ): input is ResponseInputItem[] {
    return input.every((item) => "role" in item);
  }

  private inputItemToMessage(item: ResponseInputItem): Record<string, unknown> {
    switch (item.role) {
      case "system":
        return {
          role: "system",
          content: typeof item.content === "string" ? item.content : "",
        };
      case "user":
        return {
          role: "user",
          content: this.inputContentToMessageContent(item.content),
        };
      case "assistant":
        return this.assistantInputToMessage(item);
      case "tool":
        return {
          role: "tool",
          content: typeof item.content === "string" ? item.content : "",
          tool_call_id: item.toolCallId,
        };
      default:
        return {
          role: item.role,
          content: typeof item.content === "string" ? item.content : "",
        };
    }
  }

  private assistantInputToMessage(item: ResponseInputItem): Record<string, unknown> {
    if (typeof item.content === "string" || item.content == null) {
      return {
        role: "assistant",
        content: item.content ?? "",
      };
    }

    if (this.isResponseOutputItems(item.content)) {
      const textContent = item.content
        .filter(
          (
            output,
          ): output is ResponseOutput & { type: "text"; text: string } =>
            output.type === "text" && typeof output.text === "string",
        )
        .map((output) => output.text);
      const toolCalls = item.content
        .filter(
          (
            output,
          ): output is ResponseOutput & {
            type: "tool_call";
            toolCall: ResponseToolCall;
          } => output.type === "tool_call" && !!output.toolCall,
        )
        .map((output) => ({
          id: output.toolCall.id,
          type: "function",
          function: {
            name: output.toolCall.name,
            arguments: output.toolCall.arguments,
          },
        }));

      return {
        role: "assistant",
        content: textContent.join(""),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }

    return {
      role: "assistant",
      content: this.contentBlocksToParts(item.content),
    };
  }

  private isResponseOutputItems(
    content: ContentBlock[] | ResponseOutput[],
  ): content is ResponseOutput[] {
    return content.every(
      (item) =>
        item.type === "text" ||
        item.type === "tool_call" ||
        item.type === "reasoning",
    );
  }

  private inputContentToMessageContent(
    content: ResponseInputItem["content"],
  ): string | ChatContentPart[] {
    if (typeof content === "string" || content == null) {
      return content ?? "";
    }

    if (this.isResponseOutputItems(content)) {
      return content
        .filter(
          (
            output,
          ): output is ResponseOutput & {
            type: "text" | "reasoning";
            text?: string;
            reasoningContent?: string;
          } =>
            (output.type === "text" && typeof output.text === "string") ||
            (output.type === "reasoning" &&
              typeof output.reasoningContent === "string"),
        )
        .map((output) =>
          output.type === "reasoning"
            ? output.reasoningContent ?? ""
            : output.text ?? "",
        )
        .join("");
    }

    return this.contentBlocksToParts(content);
  }

  private contentBlocksToParts(blocks: ContentBlock[]): ChatContentPart[] {
    return blocks.map((block) => this.contentBlockToPart(block));
  }

  private contentBlockToPart(block: ContentBlock): ChatContentPart {
    switch (block.type) {
      case "text":
        return { type: "text", text: block.text ?? "" };
      case "image":
        if (block.imageUrl) {
          return { type: "image_url", image_url: { url: block.imageUrl } };
        }
        if (block.data) {
          return {
            type: "image_url",
            image_url: {
              url: `data:${block.mediaType ?? "image/png"};base64,${block.data}`,
            },
          };
        }
        return { type: "text", text: block.text ?? "[image: unresolved]" };
      case "audio":
        if (block.data) {
          return {
            type: "input_audio",
            input_audio: {
              data: block.data,
              format: (block.mediaType ?? "audio/wav").split("/")[1] ?? "wav",
            },
          };
        }
        return { type: "text", text: block.text ?? "[audio: unresolved]" };
      case "video":
        if (block.data) {
          return {
            type: "image_url",
            image_url: {
              url: `data:${block.mediaType ?? "video/mp4"};base64,${block.data}`,
            },
          };
        }
        return { type: "text", text: block.text ?? "[video: unresolved]" };
      case "file": {
        const mime = block.mediaType ?? "";
        if (block.data && mime.startsWith("image/")) {
          return {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${block.data}` },
          };
        }
        if (block.data && mime.startsWith("audio/")) {
          return {
            type: "input_audio",
            input_audio: {
              data: block.data,
              format: mime.split("/")[1] ?? "wav",
            },
          };
        }
        if (block.data && mime.startsWith("video/")) {
          return {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${block.data}` },
          };
        }
        return {
          type: "text",
          text: block.text ?? "[file: unsupported]",
        };
      }
      default:
        return { type: "text", text: block.text ?? "" };
    }
  }

  private async post(body: ChatCompletionRequest): Promise<Response> {
    if (!this.apiKey) {
      throw new OctomilError(
        "AUTHENTICATION_FAILED",
        "ResponsesClient requires apiKey for cloud requests",
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
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
        `Responses request failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`,
      );
    }

    return response;
  }

  private cacheResponse(response: ResponseObj): void {
    if (this.responseCache.size >= this.maxCache) {
      const first = this.responseCache.keys().next().value;
      if (first) {
        this.responseCache.delete(first);
        this.messageCache.delete(first);
      }
    }
    this.responseCache.set(response.id, response);
  }

  private cacheMessages(id: string, messages: ResponseInputItem[]): void {
    if (this.messageCache.size >= this.maxCache) {
      const first = this.messageCache.keys().next().value;
      if (first) {
        this.messageCache.delete(first);
      }
    }
    this.messageCache.set(id, messages.map((item) => ({ ...item })));
  }

  private parseResponse(data: ChatCompletionResponse): ResponseObj {
    const choice = data.choices[0];
    const output: ResponseOutput[] = [];

    if (choice?.message.reasoning_content) {
      output.push({
        type: "reasoning",
        reasoningContent: choice.message.reasoning_content,
      });
    }
    if (choice?.message.content) {
      output.push({ type: "text", text: choice.message.content });
    }
    if (choice?.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        output.push({
          type: "tool_call",
          toolCall: {
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
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

  private responseToAssistantInput(response: ResponseObj): ResponseInputItem {
    return {
      role: "assistant",
      content: response.output,
    };
  }
}

export function generateId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
