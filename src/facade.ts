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
import type {
  LocalRunnerEndpoint,
  LocalRunnerDiscoveryOptions,
} from "./local.js";
import {
  discoverLocalRunner,
  discoverFromEnv,
  localRunnerMultipartPost,
  localRunnerPost,
  localRunnerHealthCheck,
} from "./local.js";
import { PlannerClient } from "./runtime/routing/planner-client.js";
import type { PlannerResult } from "./runtime/routing/request-router.js";
import type { LocalLifecycleStatus } from "./local-lifecycle.js";
import {
  buildLocalLifecycleStatus,
  buildUnavailableStatus,
} from "./local-lifecycle.js";
import { isCloudBlocked, resolvePlannerEnabled } from "./planner-defaults.js";
import { prepareForFacade } from "./prepare/prepare.js";
import { PrepareManager } from "./prepare/prepare-manager.js";
import type { PrepareOptions, PrepareOutcome } from "./prepare/prepare.js";
import { RuntimePlannerClient } from "./planner/client.js";

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
  plannerRouting?: boolean;
  externalEndpoint?: string;
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

  async *stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent> {
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

  async *stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent> {
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
// LocalFacadeAudioSpeech
// ---------------------------------------------------------------------------

/** Audio speech synthesis result returned by the unified Node facade. */
export interface FacadeSpeechResponse {
  audioBytes: Uint8Array;
  contentType: string;
  format: string;
  model: string;
  provider: string | null;
  voice?: string;
  sampleRate?: number;
  durationMs?: number;
  latencyMs: number;
  /** Routing metadata. No user content (input text, raw audio, file paths). */
  route: {
    locality: "on_device" | "cloud";
    engine: string | null;
    fallbackUsed: boolean;
  };
  billedUnits: number | null;
  unitKind: string | null;
}

type SpeechLocalEndpoint = {
  baseUrl: string;
  token?: string;
};

type SpeechResponseFormat =
  | "mp3"
  | "wav"
  | "ogg"
  | "opus"
  | "flac"
  | "aac"
  | "pcm";

interface FacadeSpeechCreateOptions {
  model: string;
  input: string;
  voice?: string;
  responseFormat?: SpeechResponseFormat;
  speed?: number;
}

/** TTS via the local runner. Never sends requests to cloud. */
class LocalFacadeAudioSpeech {
  constructor(private readonly endpoint: SpeechLocalEndpoint) {}

  async create(
    options: FacadeSpeechCreateOptions,
  ): Promise<FacadeSpeechResponse> {
    if (!options.input || !options.input.trim()) {
      throw new OctomilError(
        "INVALID_INPUT",
        "`input` must be a non-empty string.",
      );
    }
    if (options.responseFormat && options.responseFormat !== "wav") {
      throw new OctomilError(
        "INVALID_INPUT",
        "format_not_supported_for_local_tts: local sherpa-onnx returns WAV. " +
          "Cloud-routed apps can request other formats; local apps should " +
          "request 'wav' until local transcoding ships.",
      );
    }

    const t0 = Date.now();
    const response = await postLocalSpeech(this.endpoint, {
      model: options.model,
      input: options.input,
      voice: options.voice,
      response_format: options.responseFormat ?? "wav",
      speed: options.speed ?? 1.0,
    });
    const audioBytes = new Uint8Array(await response.arrayBuffer());
    const latencyMs = Date.now() - t0;

    const sampleRate = response.headers.get("x-octomil-sample-rate");
    const durationMs = response.headers.get("x-octomil-duration-ms");
    const voice = response.headers.get("x-octomil-voice") || undefined;

    return {
      audioBytes,
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
      format: "wav",
      model: options.model,
      provider: null, // local execution: never carries an upstream provider
      voice: voice || options.voice,
      sampleRate: sampleRate ? Number(sampleRate) : undefined,
      durationMs: durationMs ? Number(durationMs) : undefined,
      latencyMs,
      route: {
        locality: "on_device",
        engine: "sherpa-onnx",
        fallbackUsed: false,
      },
      billedUnits: null, // local execution: no cloud_usage_logs row
      unitKind: null,
    };
  }
}

/** TTS via the hosted /v1/audio/speech endpoint. */
class HostedFacadeAudioSpeech {
  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
  ) {}

  async create(
    options: FacadeSpeechCreateOptions,
  ): Promise<FacadeSpeechResponse> {
    if (!options.input || !options.input.trim()) {
      throw new OctomilError(
        "INVALID_INPUT",
        "`input` must be a non-empty string.",
      );
    }
    const url = `${this.serverUrl.replace(/\/+$/, "")}/v1/audio/speech`;
    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          input: options.input,
          voice: options.voice,
          response_format: options.responseFormat ?? "wav",
          speed: options.speed ?? 1.0,
        }),
      });
    } catch (cause) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Hosted speech network failure: ${(cause as Error)?.message ?? cause}`,
        cause,
      );
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Hosted speech failed: HTTP ${resp.status} ${resp.statusText}${text ? ` - ${text.slice(0, 500)}` : ""}`,
      );
    }
    const audioBytes = new Uint8Array(await resp.arrayBuffer());
    const latencyMs = Date.now() - t0;

    return {
      audioBytes,
      contentType:
        resp.headers.get("content-type") ?? "application/octet-stream",
      format: options.responseFormat ?? "wav",
      model: options.model,
      provider: resp.headers.get("x-octomil-provider"),
      voice: options.voice,
      latencyMs,
      route: {
        locality: "cloud",
        engine: null,
        fallbackUsed: false,
      },
      billedUnits: parseIntOrNull(resp.headers.get("x-octomil-billed-units")),
      unitKind: resp.headers.get("x-octomil-unit-kind"),
    };
  }
}

/** Planner-routed TTS for server-side Node clients. */
class RoutedFacadeAudioSpeech {
  private readonly hosted: HostedFacadeAudioSpeech;
  private readonly local: LocalFacadeAudioSpeech | null;

  constructor(
    serverUrl: string,
    apiKey: string,
    private readonly plannerClient: PlannerClient,
    localEndpoint: SpeechLocalEndpoint | null,
  ) {
    this.hosted = new HostedFacadeAudioSpeech(serverUrl, apiKey);
    this.local = localEndpoint
      ? new LocalFacadeAudioSpeech(localEndpoint)
      : null;
  }

  async create(
    options: FacadeSpeechCreateOptions,
  ): Promise<FacadeSpeechResponse> {
    const plan = await this.plannerClient.getPlan({
      model: options.model,
      capability: "tts",
      streaming: false,
    });
    const policy = speechRoutingPolicy(plan);
    const cloudBlocked = isCloudBlocked(policy);
    const selectedLocality = speechSelectedLocality(plan);
    const fallbackBlocked =
      selectedLocality === "local" && plan?.fallback_allowed === false;
    const localRequired = cloudBlocked || selectedLocality === "local";
    const runtimeModel = speechRuntimeModel(plan, options.model);

    if (localRequired) {
      if (!this.local) {
        if (cloudBlocked || fallbackBlocked) {
          throw localTtsUnavailable(runtimeModel);
        }
      } else {
        try {
          return await this.local.create({ ...options, model: runtimeModel });
        } catch (error) {
          if (cloudBlocked || fallbackBlocked) throw error;
        }
      }
    }

    return this.hosted.create({
      ...options,
      model: isAppRef(options.model) ? options.model : runtimeModel,
    });
  }
}

async function postLocalSpeech(
  endpoint: SpeechLocalEndpoint,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "octomil-node/1.0",
  };
  if (endpoint.token) {
    headers.Authorization = `Bearer ${endpoint.token}`;
  }

  let response: Response;
  try {
    response = await fetch(
      `${endpoint.baseUrl.replace(/\/+$/, "")}/v1/audio/speech`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
  } catch (err) {
    throw new OctomilError(
      "NETWORK_UNAVAILABLE",
      "Failed to connect to local runner. Ensure the runner is started.",
      err,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OctomilError(
      "INFERENCE_FAILED",
      `Local runner request failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`,
    );
  }
  return response;
}

function speechRoutingPolicy(plan: PlannerResult | null): string | undefined {
  const appPolicy = plan?.app_resolution?.routing_policy;
  if (typeof appPolicy === "string" && appPolicy.length > 0) {
    return appPolicy;
  }
  const resolutionPolicy = plan?.resolution?.routing_policy;
  if (typeof resolutionPolicy === "string" && resolutionPolicy.length > 0) {
    return resolutionPolicy;
  }
  return plan?.policy;
}

function speechSelectedLocality(
  plan: PlannerResult | null,
): "local" | "cloud" | null {
  if (!plan?.candidates.length) {
    return null;
  }
  const selected = [...plan.candidates].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
  )[0];
  return selected?.locality ?? null;
}

function speechRuntimeModel(
  plan: PlannerResult | null,
  requestedModel: string,
): string {
  const appModel = plan?.app_resolution?.selected_model;
  if (typeof appModel === "string" && appModel.length > 0) {
    return appModel;
  }
  const resolvedModel = plan?.resolution?.resolved_model;
  if (typeof resolvedModel === "string" && resolvedModel.length > 0) {
    return resolvedModel;
  }
  return requestedModel;
}

function localTtsUnavailable(model: string): OctomilError {
  return new OctomilError(
    "RUNTIME_UNAVAILABLE",
    "local_tts_runtime_unavailable: local TTS is required by this app's " +
      `routing policy, but no local runner endpoint is configured for '${model}'. ` +
      "Set OCTOMIL_LOCAL_RUNNER_URL and OCTOMIL_LOCAL_RUNNER_TOKEN, or use Octomil.local().",
  );
}

function isAppRef(model: string): boolean {
  return model.startsWith("@app/");
}

function parseIntOrNull(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function serverApiKeyFromOptions(
  options: OctomilFacadeOptions,
): string | undefined {
  if (options.apiKey) return options.apiKey;
  if (options.auth) {
    return options.auth.type === "org_api_key"
      ? options.auth.apiKey
      : options.auth.bootstrapToken;
  }
  return undefined;
}

function speechLocalEndpointFromOptions(
  options: OctomilFacadeOptions,
): SpeechLocalEndpoint | null {
  if (options.externalEndpoint) {
    return { baseUrl: options.externalEndpoint.replace(/\/+$/, "") };
  }
  return discoverFromEnv();
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
  private _audioSpeech:
    | LocalFacadeAudioSpeech
    | HostedFacadeAudioSpeech
    | RoutedFacadeAudioSpeech
    | undefined;
  private readonly _plannerClient: PlannerClient | null;
  private readonly _speechLocalEndpoint: SpeechLocalEndpoint | null;
  /** Lazy-built RuntimePlannerClient used only by `prepare(...)`. The
   * routing-layer PlannerClient drops prepare-lifecycle metadata, so
   * prepare needs the parsed RuntimePlanResponse from `planner/client.ts`. */
  private _preparePlanner: RuntimePlannerClient | undefined;

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
    this._speechLocalEndpoint =
      this._localEndpoint ?? speechLocalEndpointFromOptions(options);

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
   * Check the local runtime lifecycle status.
   *
   * Returns status indicating runner availability, cache state, and
   * execution locality. Useful for pre-flight checks and telemetry.
   *
   * For non-local clients, returns a status with `runnerAvailable: false`
   * and `cacheStatus: "not_applicable"`.
   */
  async getLocalStatus(): Promise<LocalLifecycleStatus> {
    if (!this._localEndpoint) {
      return buildUnavailableStatus("not_local_client", "not_applicable");
    }

    const healthy = await localRunnerHealthCheck(this._localEndpoint);
    if (!healthy) {
      return buildUnavailableStatus("runner_unreachable");
    }

    return buildLocalLifecycleStatus({
      runnerAvailable: true,
      cacheStatus: "not_applicable", // model/artifact cache is resolved per request
      engine: null, // engine is resolved per-request by the runner
    });
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

  /**
   * Resolve a planner candidate for `model` and return a structured
   * description of the on-device artifact that would be prepared.
   *
   * The Node SDK does not yet materialize artifacts on its own — the
   * Python CLI (`octomil prepare`) is the supported way to actually
   * download today. This method returns the planner's intent so Node
   * callers can:
   *
   *   - decide whether the app routes locally at all (`outcome.preparePolicy`)
   *   - shell out to `octomil prepare <model>` from a host process
   *   - surface the same actionable errors users see in Python before
   *     committing to a local route.
   *
   * `outcome.prepared` is always `false` today and will flip to `true`
   * once the Node SDK grows its own durable downloader.
   *
   * @example
   * ```ts
   * const plan = await client.prepare({ model: "@app/eternum/tts" });
   * if (plan.preparePolicy === "explicit_only") {
   *   // run `octomil prepare @app/eternum/tts` from your build step
   * }
   * ```
   */
  async prepare(options: PrepareOptions): Promise<PrepareOutcome> {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    const plannerClient = this.preparePlannerClient();
    // PR 12: ``client.prepare(...)`` materializes bytes — the public
    // facade is the explicit caller-driven path. Lazily instantiate a
    // single ``PrepareManager`` per facade instance so progress
    // journal + lock dir + the warmup cache stay shared across calls.
    // Callers can override by passing ``options.materializer``
    // explicitly (kept for tests / advanced flows).
    const materializer = options.materializer ?? this.preparePrepareManager();
    return prepareForFacade(plannerClient, { ...options, materializer });
  }

  private preparePrepareManager(): PrepareManager {
    if (!this._prepareManager) {
      this._prepareManager = new PrepareManager();
    }
    return this._prepareManager;
  }
  private _prepareManager?: PrepareManager;

  private preparePlannerClient(): RuntimePlannerClient {
    // The facade's existing routing-layer PlannerClient returns a
    // PlannerResult shape that drops prepare-lifecycle metadata; build
    // a RuntimePlannerClient (planner/client.ts) so prepare sees the
    // full schema with delivery_mode, prepare_required, prepare_policy,
    // download_urls, etc. Reuse this instance across calls so the
    // network connection stays warm for repeat prepares.
    if (!this._preparePlanner) {
      const baseUrl = this.options.serverUrl ?? "https://api.octomil.com";
      const apiKey =
        this.options.publishableKey ??
        this.options.apiKey ??
        (this.options.auth?.type === "org_api_key"
          ? this.options.auth.apiKey
          : undefined);
      this._preparePlanner = new RuntimePlannerClient({
        baseUrl,
        apiKey,
      });
    }
    return this._preparePlanner;
  }

  /**
   * Audio speech (TTS) namespace.
   *
   * Server-side clients ask the runtime planner before dispatch. Apps with
   * `Private`/`local_only` policy require a configured local runner endpoint
   * and never call the hosted gateway.
   */
  get audioSpeech():
    | LocalFacadeAudioSpeech
    | HostedFacadeAudioSpeech
    | RoutedFacadeAudioSpeech {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    if (!this._audioSpeech) {
      if (this._localEndpoint) {
        this._audioSpeech = new LocalFacadeAudioSpeech(this._localEndpoint);
      } else {
        const apiKey = serverApiKeyFromOptions(this.options);
        if (!apiKey) {
          throw new OctomilError(
            "AUTHENTICATION_FAILED",
            "audio.speech requires a server-side apiKey. Publishable keys cannot call hosted speech.",
          );
        }
        const serverUrl = this.options.serverUrl ?? "https://api.octomil.com";
        this._audioSpeech = this._plannerClient
          ? new RoutedFacadeAudioSpeech(
              serverUrl,
              apiKey,
              this._plannerClient,
              this._speechLocalEndpoint,
            )
          : new HostedFacadeAudioSpeech(serverUrl, apiKey);
      }
    }
    return this._audioSpeech;
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
