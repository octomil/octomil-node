/**
 * AudioTranscriptions — speech-to-text API.
 *
 * Wraps the underlying audio runtime to provide transcription.
 * Supports both non-streaming (create) and streaming (stream) modes.
 */

import type { ModelRef } from "../model-ref.js";
import { ModelRef as ModelRefFactory } from "../model-ref.js";
import { ModelCapability } from "../_generated/model_capability.js";
import type { ModelRuntime } from "../runtime/core/model-runtime.js";
import type { TranscriptionResult, TranscriptionSegment } from "./transcription-types.js";
import { OctomilError } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionRequest {
  model?: ModelRef;
  audio: Uint8Array;
  language?: string;
}

export type RuntimeResolver = (ref: ModelRef) => ModelRuntime | undefined;

// ---------------------------------------------------------------------------
// AudioTranscriptions
// ---------------------------------------------------------------------------

export class AudioTranscriptions {
  private readonly runtimeResolver: RuntimeResolver;

  constructor(runtimeResolver: RuntimeResolver) {
    this.runtimeResolver = runtimeResolver;
  }

  /**
   * Transcribe audio to text (non-streaming).
   */
  async create(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const model = request.model ?? ModelRefFactory.capability(ModelCapability.Transcription);
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
