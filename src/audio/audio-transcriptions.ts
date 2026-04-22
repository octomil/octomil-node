/**
 * AudioTranscriptions — speech-to-text API.
 *
 * Wraps the underlying audio runtime to provide transcription.
 * Supports both non-streaming (create) and streaming (stream) modes.
 *
 * When a PlannerClient is configured, routes through the planner candidate
 * loop and keeps route metadata aligned with the transport that actually ran.
 */

import type { ModelRef } from "../model-ref.js";
import { ModelRef as ModelRefFactory } from "../model-ref.js";
import { ModelCapability } from "../_generated/model_capability.js";
import type { ModelRuntime } from "../runtime/core/model-runtime.js";
import type {
  TranscriptionResult,
  TranscriptionSegment,
} from "./transcription-types.js";
import { OctomilError } from "../types.js";
import {
  CandidateAttemptRunner,
  type AttemptLoopResult,
  type CandidatePlan,
  type RuntimeChecker,
} from "../runtime/routing/attempt-runner.js";
import type { PlannerClient } from "../runtime/routing/planner-client.js";
import type { RouteMetadata } from "../runtime/routing/request-router.js";
import { buildRouteEvent, type RouteEvent } from "../runtime/routing/route-event.js";
import { parseModelRef } from "../runtime/routing/model-ref-parser.js";

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
  externalEndpoint?: string;
}

// ---------------------------------------------------------------------------
// AudioTranscriptions
// ---------------------------------------------------------------------------

export class AudioTranscriptions {
  private readonly runtimeResolver: RuntimeResolver;
  private readonly plannerClient: PlannerClient | null;
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly externalEndpoint: string | null;

  /** Route info from the last completed request. */
  lastRouteInfo: AudioRouteInfo | null = null;

  constructor(runtimeResolverOrOptions: RuntimeResolver | AudioTranscriptionsOptions) {
    if (typeof runtimeResolverOrOptions === "function") {
      this.runtimeResolver = runtimeResolverOrOptions;
      this.plannerClient = null;
      this.serverUrl = "";
      this.apiKey = "";
      this.externalEndpoint = null;
    } else {
      this.runtimeResolver = runtimeResolverOrOptions.runtimeResolver;
      this.plannerClient = runtimeResolverOrOptions.plannerClient ?? null;
      this.serverUrl = runtimeResolverOrOptions.serverUrl ?? "";
      this.apiKey = runtimeResolverOrOptions.apiKey ?? "";
      this.externalEndpoint = runtimeResolverOrOptions.externalEndpoint ?? null;
    }
  }

  /**
   * Transcribe audio to text (non-streaming).
   */
  async create(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const model =
      request.model ?? ModelRefFactory.capability(ModelCapability.Transcription);

    if (this.plannerClient && this.serverUrl) {
      return this.createWithPlanner(request, model);
    }

    return this.createLocal(request, model);
  }

  /**
   * Stream transcription segments as they are produced.
   *
   * The current transport emits full transcripts, so we yield a single segment.
   * Planner routing still applies to the underlying execution choice.
   */
  async *stream(
    request: TranscriptionRequest,
  ): AsyncGenerator<TranscriptionSegment> {
    const result = await this.create(request);
    if (result.text) {
      yield { text: result.text, startMs: 0, endMs: 0 };
    }
  }

  private async createWithPlanner(
    request: TranscriptionRequest,
    model: ModelRef,
  ): Promise<TranscriptionResult> {
    const modelRef = typeof model === "string" ? model : model.toString();
    const plan = await this.plannerClient!.getPlan({
      model: modelRef,
      capability: "audio",
      streaming: false,
    });

    const runtime = this.runtimeResolver(model);
    const candidates = plan?.candidates ?? this.audioCandidates(runtime);
    const fallbackAllowed = this.cloudFallbackAllowed(plan?.fallback_allowed);
    const runner = new CandidateAttemptRunner({ fallbackAllowed });

    const result = await runner.runWithInference<TranscriptionResult>(candidates, {
      runtimeChecker: this.audioRuntimeChecker(runtime),
      executeCandidate: async (candidate) => {
        if (candidate.locality === "local") {
          if (runtime) {
            return this.createLocal(request, model);
          }
          if (this.externalEndpoint) {
            return this.createEndpoint(request, this.externalEndpoint);
          }
        }
        return this.createCloud(request);
      },
    });

    if (!result.selectedAttempt || !result.value) {
      throw (
        result.error ??
        new OctomilError("INFERENCE_FAILED", "No transcription route succeeded")
      );
    }

    this.lastRouteInfo = this.buildRouteInfo(modelRef, plan, result, runtime);
    return result.value;
  }

  private async createLocal(
    request: TranscriptionRequest,
    model: ModelRef,
  ): Promise<TranscriptionResult> {
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

  private async createCloud(
    request: TranscriptionRequest,
  ): Promise<TranscriptionResult> {
    if (!this.serverUrl || !this.apiKey) {
      throw new OctomilError(
        "AUTHENTICATION_FAILED",
        "AudioTranscriptions requires serverUrl and apiKey for cloud requests",
      );
    }

    return this.createEndpoint(request, this.serverUrl, this.apiKey);
  }

  private async createEndpoint(
    request: TranscriptionRequest,
    baseUrl: string,
    apiKey?: string,
  ): Promise<TranscriptionResult> {
    const audioBuffer = new ArrayBuffer(request.audio.byteLength);
    new Uint8Array(audioBuffer).set(request.audio);

    const body = new FormData();
    body.append(
      "file",
      new Blob([audioBuffer], { type: "application/octet-stream" }),
      "audio.wav",
    );
    if (request.model) {
      body.append("model", String(request.model));
    }
    if (request.language) {
      body.append("language", request.language);
    }

    let response: Response;
    try {
      response = await fetch(
        `${baseUrl.replace(/\/+$/, "")}/v1/audio/transcriptions`,
        {
          method: "POST",
          headers: {
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            "User-Agent": "octomil-node/1.0",
          },
          body,
        },
      );
    } catch (error) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        "Audio transcription request failed",
        error,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Audio transcription failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`,
      );
    }

    const data = (await response.json()) as { text?: string };
    return {
      text: typeof data.text === "string" ? data.text : "",
      segments: [],
      language: request.language,
    };
  }

  private audioCandidates(runtime: ModelRuntime | undefined): CandidatePlan[] {
    const candidates: CandidatePlan[] = [];
    if (runtime || this.externalEndpoint) {
      candidates.push({
        locality: "local",
        engine: runtime ? "sdk_runtime" : "external_endpoint",
        priority: 0,
        confidence: 1,
        reason: runtime
          ? "configured local transcription runtime"
          : "configured external transcription endpoint",
      });
    }
    candidates.push({
      locality: "cloud",
      engine: "cloud",
      priority: candidates.length,
      confidence: 1,
      reason: "hosted transcription endpoint",
    });
    return candidates;
  }

  private audioRuntimeChecker(runtime: ModelRuntime | undefined): RuntimeChecker {
    return {
      check: (_engine, locality) => {
        if (locality === "cloud") {
          return this.serverUrl && this.apiKey
            ? { available: true }
            : { available: false, reasonCode: "cloud_auth_unavailable" };
        }
        if (runtime || this.externalEndpoint) {
          return { available: true };
        }
        return { available: false, reasonCode: "local_runtime_unavailable" };
      },
    };
  }

  private cloudFallbackAllowed(plannerFallbackAllowed = true): boolean {
    return plannerFallbackAllowed && !!this.serverUrl && !!this.apiKey;
  }

  private buildRouteInfo(
    model: string,
    plan: Awaited<ReturnType<PlannerClient["getPlan"]>>,
    attemptResult: AttemptLoopResult,
    runtime: ModelRuntime | undefined,
  ): AudioRouteInfo {
    const parsedRef = parseModelRef(model);
    const localMode: "sdk_runtime" | "external_endpoint" =
      runtime != null
        ? "sdk_runtime"
        : this.externalEndpoint
          ? "external_endpoint"
          : "sdk_runtime";
    const normalizeAttempt = (attempt: AttemptLoopResult["attempts"][number]) =>
      attempt.locality === "local" ? { ...attempt, mode: localMode } : attempt;
    const normalizedResult: AttemptLoopResult = {
      ...attemptResult,
      attempts: attemptResult.attempts.map(normalizeAttempt),
      selectedAttempt: attemptResult.selectedAttempt
        ? normalizeAttempt(attemptResult.selectedAttempt)
        : null,
    };

    const selected = normalizedResult.selectedAttempt;
    const locality = selected?.locality ?? "cloud";
    const mode =
      selected?.mode ??
      (locality === "cloud" ? "hosted_gateway" : localMode);
    const endpoint =
      mode === "hosted_gateway"
        ? this.serverUrl
        : mode === "external_endpoint"
          ? this.externalEndpoint ?? ""
          : "";
    const routeEvent = buildRouteEvent({
      requestId: `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      capability: "audio",
      streaming: false,
      model,
      modelRefKind: parsedRef.kind,
      policy: plan?.policy,
      plannerSource: plan ? (plan.planner_source ?? "server") : "offline",
      planId: plan?.plan_id,
      attemptResult: normalizedResult,
      deploymentId: parsedRef.deploymentId,
      experimentId: parsedRef.experimentId,
      variantId: parsedRef.variantId,
      appId: plan?.app_resolution?.app_id,
      appSlug: plan?.app_resolution?.app_slug ?? parsedRef.appSlug,
    });

    return {
      routeMetadata: {
        modelRefKind: parsedRef.kind,
        parsedRef,
        locality,
        mode,
        endpoint,
        plannerUsed: !!plan,
        attemptResult: normalizedResult,
        routeEvent,
      },
      routeEvent,
    };
  }
}
