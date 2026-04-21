/**
 * Unified Octomil facade — single-constructor entry point for the SDK.
 *
 * Supports four entry points:
 *   1. `new Octomil({ publishableKey })` — client-side / on-device usage
 *   2. `new Octomil({ apiKey, orgId })`  — server-side / CI usage
 *   3. `Octomil.fromEnv()`              — server-side from env vars
 *   4. `Octomil.local()`                — local inference via Python CLI runner
 *
 * For server-side code, prefer `Octomil.fromEnv()` so credentials stay in
 * deployment config instead of application source.
 */

import { ResponsesClient } from "./responses.js";
import type {
  ResponseRequest,
  ResponseObj,
  ResponseOutput,
  ResponseStreamEvent,
} from "./responses.js";
import { embed, embedWithPlanner } from "./embeddings.js";
import type { EmbeddingResult } from "./embeddings.js";
import { validatePublishableKey } from "./auth-config.js";
import { configure } from "./configure.js";
import type { AuthConfig } from "./types.js";
import { OctomilError } from "./types.js";
import type { LocalRunnerEndpoint, LocalRunnerDiscoveryOptions } from "./local.js";
import {
  discoverLocalRunner,
  localRunnerMultipartPost,
  localRunnerPost,
} from "./local.js";
import { PlannerClient } from "./runtime/routing/planner-client.js";
import { resolvePlannerEnabled } from "./planner-defaults.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OctomilNotInitializedError extends Error {
  constructor() {
    super(
      "Octomil client is not initialized. Call await client.initialize() first.",
    );
    this.name = "OctomilNotInitializedError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OctomilFacadeOptions {
  publishableKey?: string;
  apiKey?: string;
  orgId?: string;
  auth?: AuthConfig;
  serverUrl?: string;
  telemetry?: boolean;
  plannerRouting?: boolean;
  externalEndpoint?: string;
}

export interface OctomilFacadeEnvOptions {
  serverUrl?: string;
  telemetry?: boolean;
}

/** Options for `Octomil.local()`. */
export type OctomilLocalOptions = LocalRunnerDiscoveryOptions;

// ---------------------------------------------------------------------------
// FacadeResponses
// ---------------------------------------------------------------------------

/** Convenience wrapper around ResponsesClient that adds `outputText`. */
class FacadeResponses {
  constructor(private readonly client: ResponsesClient) {}

  async create(
    request: ResponseRequest,
  ): Promise<ResponseObj & { outputText: string }> {
    const response = await this.client.create(request);
    return Object.assign(response, {
      get outputText(): string {
        return extractOutputText(response.output);
      },
    });
  }

  async *stream(
    request: ResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    yield* this.client.stream(request);
  }
}

// ---------------------------------------------------------------------------
// LocalFacadeResponses
// ---------------------------------------------------------------------------

/** Responses wrapper that sends requests to the local runner's /v1/chat/completions. */
class LocalFacadeResponses {
  constructor(private readonly endpoint: LocalRunnerEndpoint) {}

  async create(
    request: ResponseRequest,
  ): Promise<ResponseObj & { outputText: string }> {
    const body = buildChatCompletionBody(request);
    const response = await localRunnerPost(
      this.endpoint,
      "/v1/chat/completions",
      body,
    );
    const data = (await response.json()) as ChatCompletionResponse;
    const result = parseChatCompletionResponse(data, request.model);
    return Object.assign(result, {
      get outputText(): string {
        return extractOutputText(result.output);
      },
    });
  }

  async *stream(
    request: ResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    const body = buildChatCompletionBody(request, true);
    const response = await localRunnerPost(
      this.endpoint,
      "/v1/chat/completions",
      body,
    );

    if (!response.body) {
      throw new OctomilError(
        "INFERENCE_FAILED",
        "Local runner streaming response returned empty body",
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

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const dataStr = trimmed.slice(5).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          let chunk: ChatCompletionChunk;
          try {
            chunk = JSON.parse(dataStr) as ChatCompletionChunk;
          } catch {
            continue;
          }

          responseId = chunk.id || responseId;
          responseModel = chunk.model || responseModel;

          for (const choice of chunk.choices) {
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
            if (choice.delta.content) {
              currentTextContent += choice.delta.content;
              yield { type: "text_delta", delta: choice.delta.content };
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (currentTextContent) {
      outputParts.push({ type: "text", text: currentTextContent });
    }

    const finalResponse: ResponseObj = {
      id: responseId || `resp_local_${Date.now().toString(36)}`,
      model: responseModel,
      output: outputParts,
      finishReason,
    };

    yield { type: "done", response: finalResponse };
  }
}

// ---------------------------------------------------------------------------
// FacadeEmbeddings
// ---------------------------------------------------------------------------

/** Convenience wrapper that delegates to the standalone `embed()` function. */
export class FacadeEmbeddings {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly plannerClient: PlannerClient | null;
  private readonly externalEndpoint: string | undefined;

  constructor(
    serverUrl: string,
    apiKey: string,
    plannerClient?: PlannerClient | null,
    externalEndpoint?: string,
  ) {
    this.serverUrl = serverUrl;
    this.apiKey = apiKey;
    this.plannerClient = plannerClient ?? null;
    this.externalEndpoint = externalEndpoint;
  }

  async create(options: {
    model: string;
    input: string | string[];
    signal?: AbortSignal;
  }): Promise<EmbeddingResult> {
    if (this.plannerClient) {
      return embedWithPlanner(
        {
          serverUrl: this.serverUrl,
          apiKey: this.apiKey,
          plannerClient: this.plannerClient,
          externalEndpoint: this.externalEndpoint,
        },
        options.model,
        options.input,
        options.signal,
      );
    }
    return embed(
      { serverUrl: this.serverUrl, apiKey: this.apiKey },
      options.model,
      options.input,
      options.signal,
    );
  }
}

// ---------------------------------------------------------------------------
// LocalFacadeEmbeddings
// ---------------------------------------------------------------------------

/** Embeddings wrapper that sends requests to the local runner's /v1/embeddings. */
class LocalFacadeEmbeddings {
  constructor(private readonly endpoint: LocalRunnerEndpoint) {}

  async create(options: {
    model: string;
    input: string | string[];
    signal?: AbortSignal;
  }): Promise<EmbeddingResult> {
    const body = { model: options.model, input: options.input };
    const response = await localRunnerPost(
      this.endpoint,
      "/v1/embeddings",
      body,
    );
    const data = (await response.json()) as EmbeddingResponse;
    return {
      embeddings: data.data.map((d) => d.embedding),
      model: data.model,
      usage: {
        promptTokens: data.usage.prompt_tokens,
        totalTokens: data.usage.total_tokens,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// LocalFacadeAudioTranscriptions
// ---------------------------------------------------------------------------

/** Audio transcription result. */
export interface LocalTranscriptionResult {
  text: string;
  segments: Array<{ text: string; startMs: number; endMs: number }>;
  language?: string;
}

/** Audio transcription wrapper that sends requests to the local runner. */
class LocalFacadeAudioTranscriptions {
  constructor(private readonly endpoint: LocalRunnerEndpoint) {}

  async create(options: {
    model?: string;
    audio: Uint8Array;
    language?: string;
  }): Promise<LocalTranscriptionResult> {
    const audioBuffer = new ArrayBuffer(options.audio.byteLength);
    new Uint8Array(audioBuffer).set(options.audio);

    const body = new FormData();
    body.append(
      "file",
      new Blob([audioBuffer], { type: "application/octet-stream" }),
      "audio.wav",
    );
    if (options.model) {
      body.append("model", options.model);
    }
    if (options.language) {
      body.append("language", options.language);
    }

    const response = await localRunnerMultipartPost(
      this.endpoint,
      "/v1/audio/transcriptions",
      body,
    );
    const data = (await response.json()) as { text: string };
    return {
      text: data.text,
      segments: [],
      language: options.language,
    };
  }
}

// ---------------------------------------------------------------------------
// Octomil facade
// ---------------------------------------------------------------------------

export class Octomil {
  private initialized = false;
  private readonly responsesClient: ResponsesClient | null;
  private readonly _embeddings: FacadeEmbeddings | LocalFacadeEmbeddings;
  private readonly options: OctomilFacadeOptions;
  private _responses: FacadeResponses | undefined;
  /** Set when this instance was created via `Octomil.local()`. */
  private readonly _localEndpoint: LocalRunnerEndpoint | null;
  private _localResponses: LocalFacadeResponses | undefined;
  private _localAudioTranscriptions: LocalFacadeAudioTranscriptions | undefined;
  private readonly _plannerClient: PlannerClient | null;

  /**
   * Create a local-only Octomil client that uses the Python CLI's local runner.
   *
   * Never sends requests to the hosted cloud.
   * Discovers the runner via env vars or the CLI subprocess.
   *
   * @example
   * ```ts
   * const client = await Octomil.local();
   * await client.initialize();
   * const response = await client.responses.create({ model: "default", input: "hello" });
   * ```
   */
  static async local(options: OctomilLocalOptions = {}): Promise<Octomil> {
    const endpoint = await discoverLocalRunner(options);
    return new Octomil({}, endpoint);
  }

  static fromEnv(options: OctomilFacadeEnvOptions = {}): Octomil {
    const apiKey =
      process.env.OCTOMIL_SERVER_KEY || process.env.OCTOMIL_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Set OCTOMIL_SERVER_KEY before calling Octomil.fromEnv() " +
          "(or set OCTOMIL_API_KEY for legacy compatibility).",
      );
    }

    const orgId = process.env.OCTOMIL_ORG_ID;
    if (!orgId) {
      throw new Error("Set OCTOMIL_ORG_ID before calling Octomil.fromEnv().");
    }

    return new Octomil({
      ...options,
      apiKey,
      orgId,
    });
  }

  constructor(
    options: OctomilFacadeOptions,
    localEndpoint?: LocalRunnerEndpoint,
  ) {
    this.options = options;
    this._localEndpoint = localEndpoint ?? null;

    // Validate publishable key eagerly so constructor throws on bad prefix.
    if (options.publishableKey) {
      validatePublishableKey(options.publishableKey);
    }

    if (this._localEndpoint) {
      // Local mode: use the local runner endpoint for everything
      this.responsesClient = null;
      this._embeddings = new LocalFacadeEmbeddings(this._localEndpoint);
      this._plannerClient = null;
    } else {
      // Hosted mode: build a ResponsesClient from the resolved auth credentials.
      const serverUrl = options.serverUrl ?? "https://api.octomil.com";

      let apiKey: string | undefined;
      if (options.publishableKey) {
        apiKey = options.publishableKey;
      } else if (options.apiKey) {
        apiKey = options.apiKey;
      } else if (options.auth) {
        apiKey =
          options.auth.type === "org_api_key"
            ? options.auth.apiKey
            : options.auth.bootstrapToken;
      }

      const plannerEnabled = resolvePlannerEnabled({
        plannerRouting: options.plannerRouting,
        apiKey,
        publishableKey: options.publishableKey,
        hasAuth: !!options.auth,
      });

      if (plannerEnabled && apiKey) {
        this._plannerClient = new PlannerClient({
          serverUrl,
          apiKey,
        });
      } else {
        this._plannerClient = null;
      }

      this.responsesClient = new ResponsesClient({
        serverUrl,
        apiKey,
        plannerClient: this._plannerClient,
        externalEndpoint: options.externalEndpoint,
      });

      this._embeddings = new FacadeEmbeddings(
        serverUrl,
        apiKey ?? "",
        this._plannerClient,
        options.externalEndpoint,
      );
    }
  }

  /**
   * Initialize the client. Must be called (and awaited) before using
   * `responses`. Idempotent — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // For local mode, skip auth validation — the runner token is enough.
    if (this._localEndpoint) {
      this.initialized = true;
      return;
    }

    // Validate that at least one auth method was provided.
    if (
      !this.options.publishableKey &&
      !this.options.apiKey &&
      !this.options.auth
    ) {
      throw new Error(
        "Octomil requires one of: publishableKey, apiKey + orgId, or auth",
      );
    }

    if (this.options.apiKey && !this.options.orgId && !this.options.auth) {
      throw new Error("orgId is required when using apiKey");
    }

    // For publishable key path, trigger device registration (fire-and-forget).
    if (this.options.publishableKey) {
      configure({
        auth: { type: "publishable_key", key: this.options.publishableKey },
        baseUrl: this.options.serverUrl,
      }).catch(() => {});
    }

    this.initialized = true;
  }

  /**
   * Whether this client was created via `Octomil.local()`.
   */
  get isLocal(): boolean {
    return this._localEndpoint !== null;
  }

  /**
   * Responses namespace. Throws OctomilNotInitializedError if `initialize()`
   * has not been called.
   */
  get responses(): FacadeResponses | LocalFacadeResponses {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    if (this._localEndpoint) {
      if (!this._localResponses) {
        this._localResponses = new LocalFacadeResponses(this._localEndpoint);
      }
      return this._localResponses;
    }
    if (!this._responses) {
      this._responses = new FacadeResponses(this.responsesClient!);
    }
    return this._responses;
  }

  /**
   * Embeddings namespace. Throws OctomilNotInitializedError if `initialize()`
   * has not been called.
   */
  get embeddings(): FacadeEmbeddings | LocalFacadeEmbeddings {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    return this._embeddings;
  }

  /**
   * Audio transcriptions namespace (local mode only).
   * Throws OctomilNotInitializedError if `initialize()` has not been called.
   * Throws OctomilError if not in local mode.
   */
  get audioTranscriptions(): LocalFacadeAudioTranscriptions {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    if (!this._localEndpoint) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "Audio transcriptions via local runner require Octomil.local(). " +
          "Use the audio namespace on OctomilClient for hosted transcription.",
      );
    }
    if (!this._localAudioTranscriptions) {
      this._localAudioTranscriptions = new LocalFacadeAudioTranscriptions(
        this._localEndpoint,
      );
    }
    return this._localAudioTranscriptions;
  }
}

// ---------------------------------------------------------------------------
// Internal types for OpenAI-compatible responses
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
    };
    finish_reason: string | null;
  }>;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractOutputText(output: ResponseOutput[]): string {
  return output
    .filter((o) => o.type === "text")
    .map((o) => o.text ?? "")
    .join("");
}

function buildChatCompletionBody(
  request: ResponseRequest,
  stream = false,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
  } else if (Array.isArray(request.input)) {
    for (const item of request.input) {
      if ("role" in item) {
        messages.push({
          role: item.role,
          content:
            typeof item.content === "string"
              ? item.content
              : JSON.stringify(item.content),
        });
      } else {
        // ContentBlock[]
        messages.push({
          role: "user",
          content: JSON.stringify(request.input),
        });
        break;
      }
    }
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream,
  };

  if (request.maxOutputTokens != null) {
    body.max_tokens = request.maxOutputTokens;
  }
  if (request.temperature != null) {
    body.temperature = request.temperature;
  }
  if (request.topP != null) {
    body.top_p = request.topP;
  }
  if (request.stop) {
    body.stop = request.stop;
  }

  return body;
}

function parseChatCompletionResponse(
  data: ChatCompletionResponse,
  fallbackModel: string,
): ResponseObj {
  const choice = data.choices[0];
  const output: ResponseOutput[] = [];

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
    model: data.model || fallbackModel,
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
