/**
 * AudioTranscriptions — speech-to-text API.
 *
 * Wraps the underlying audio runtime to provide transcription.
 * Supports both non-streaming (create) and streaming (stream) modes.
 *
 * When a PlannerClient is configured, routes through the planner
 * candidate evaluation loop before falling back to the runtime resolver.
 * Audio is cloud-only for hosted transcription in the Node SDK; local
 * transcription requires a ModelRuntime (via sdk_runtime or external_endpoint).
 */

import type { ModelRef } from "../model-ref.js";
import { ModelRef as ModelRefFactory } from "../model-ref.js";
import { ModelCapability } from "../_generated/model_capability.js";
import type { ModelRuntime } from "../runtime/core/model-runtime.js";
import type { TranscriptionResult, TranscriptionSegment } from "./transcription-types.js";
import { OctomilError } from "../types.js";
import type { PlannerClient } from "../runtime/routing/planner-client.js";
import {
  RequestRouter,
  type RouteMetadata,
} from "../runtime/routing/request-router.js";
import type { RouteEvent } from "../runtime/routing/route-event.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionRequest {
  model?: ModelRef;
  audio: Uint8Array;
  language?: string;
}

export type RuntimeResolver = (ref: ModelRef) => ModelRuntime | undefined;

/** Route info from a planner-routed audio request. */
export interface AudioRouteInfo {
  routeMetadata?: RouteMetadata;
  routeEvent?: RouteEvent;
}

/** Options for AudioTranscriptions constructor. */
export interface AudioTranscriptionsOptions {
  runtimeResolver: RuntimeResolver;
  plannerClient?: PlannerClient | null;
  serverUrl?: string;
  apiKey?: string;
}

// ---------------------------------------------------------------------------
// AudioTranscriptions
// ---------------------------------------------------------------------------

export class AudioTranscriptions {
  private readonly runtimeResolver: RuntimeResolver;
  private readonly plannerClient: PlannerClient | null;
  private readonly serverUrl: string;
  private readonly apiKey: string;

  /** Route info from the last completed request. */
  lastRouteInfo: AudioRouteInfo | null = null;

  constructor(runtimeResolverOrOptions: RuntimeResolver | AudioTranscriptionsOptions) {
    if (typeof runtimeResolverOrOptions === "function") {
      // Legacy constructor signature
      this.runtimeResolver = runtimeResolverOrOptions;
      this.plannerClient = null;
      this.serverUrl = "";
      this.apiKey = "";
    } else {
      this.runtimeResolver = runtimeResolverOrOptions.runtimeResolver;
      this.plannerClient = runtimeResolverOrOptions.plannerClient ?? null;
      this.serverUrl = runtimeResolverOrOptions.serverUrl ?? "";
      this.apiKey = runtimeResolverOrOptions.apiKey ?? "";
    }
  }

  /**
   * Transcribe audio to text (non-streaming).
   */
  async create(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const model = request.model ?? ModelRefFactory.capability(ModelCapability.Transcription);

    // Planner-routed path
    if (this.plannerClient && this.serverUrl) {
      return this.createWithPlanner(request, model);
    }

    // Legacy path: direct runtime resolver
    const runtime = this.runtimeResolver(model);
    if (!runtime) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "No runtime for transcription model",
      );
    }

    const result = await runtime.run({
      prompt: request.language ?? "",
      mediaData: request.audio,
      mediaType: "audio",
    });

    const text = typeof result["text"] === "string" ? result["text"] : "";
    return {
      text,
      segments: [],
      language: request.language,
    };
  }

  /**
   * Planner-routed create: fetch plan, evaluate candidates, execute.
   *
   * Audio in the Node SDK only supports cloud (hosted) and local runtime.
   * There is no native audio inference engine in the Node SDK.
   */
  private async createWithPlanner(
    request: TranscriptionRequest,
    model: ModelRef,
  ): Promise<TranscriptionResult> {
    const modelStr = typeof model === "string" ? model : model.toString();
    const plan = await this.plannerClient!.getPlan({
      model: modelStr,
      capability: "audio",
      streaming: false,
    });

    const router = new RequestRouter({
      cloudEndpoint: this.serverUrl,
      apiKey: this.apiKey,
    });

    const decision = router.resolve({
      model: modelStr,
      capability: "audio",
      streaming: false,
      plannerResult: plan ?? undefined,
    });

    this.lastRouteInfo = {
      routeMetadata: decision.routeMetadata,
      routeEvent: decision.routeMetadata.routeEvent,
    };

    // Try local runtime first if selected
    if (decision.locality === "local") {
      const runtime = this.runtimeResolver(model);
      if (runtime) {
        const result = await runtime.run({
          prompt: request.language ?? "",
          mediaData: request.audio,
          mediaType: "audio",
        });
        const text = typeof result["text"] === "string" ? result["text"] : "";
        return { text, segments: [], language: request.language };
      }
    }

    // Cloud path — audio transcription is not supported as a direct cloud
    // endpoint in the Node SDK facade. The user must use LocalFacadeAudioTranscriptions
    // or provide a ModelRuntime. Fail clearly.
    const runtime = this.runtimeResolver(model);
    if (!runtime) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "No runtime for transcription model. " +
          "Audio transcription in the Node SDK requires a local ModelRuntime or " +
          "Octomil.local() for the local runner. Cloud-hosted audio transcription " +
          "is available via the REST API directly.",
      );
    }

    const result = await runtime.run({
      prompt: request.language ?? "",
      mediaData: request.audio,
      mediaType: "audio",
    });
    const text = typeof result["text"] === "string" ? result["text"] : "";
    return { text, segments: [], language: request.language };
  }

  /**
   * Stream transcription segments as they are produced.
   */
  async *stream(
    request: TranscriptionRequest,
  ): AsyncGenerator<TranscriptionSegment> {
    const model = request.model ?? ModelRefFactory.capability(ModelCapability.Transcription);
    const runtime = this.runtimeResolver(model);
    if (!runtime) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "No runtime for transcription model",
      );
    }

    // Fallback: run full transcription and yield as a single segment.
    const result = await runtime.run({
      prompt: "",
      mediaData: request.audio,
      mediaType: "audio",
    });

    const text = typeof result["text"] === "string" ? result["text"] : "";
    if (text) {
      yield { text, startMs: 0, endMs: 0 };
    }
  }
}
