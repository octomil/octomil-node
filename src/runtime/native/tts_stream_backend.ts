/**
 * NativeTtsStreamBackend — audio.tts.stream via octomil-runtime v0.1.9+.
 *
 * Hard-cutover backend for streaming TTS with sentence-bounded progressive
 * delivery. Mirrors octomil-python/octomil/runtime/native/tts_stream_backend.py.
 *
 * The runtime advertises audio.tts.stream only when:
 *   1. Built with OCT_HAVE_SHERPA_ONNX_TTS.
 *   2. OCTOMIL_SHERPA_TTS_MODEL points at the pinned VITS .onnx with
 *      sibling tokens.txt + espeak-ng-data/.
 *
 * v0.1.9 flip: delivery_timing = progressive_during_synthesis.
 * first_audio_ratio = 0.5909 (gate < 0.75, gate_pass = true).
 *
 * Bounded-error mapping (audio backend policy):
 *   OCT_STATUS_NOT_FOUND         → MODEL_NOT_FOUND
 *   OCT_STATUS_INVALID_INPUT     → INVALID_INPUT
 *   OCT_STATUS_UNSUPPORTED w/ "digest" → CHECKSUM_MISMATCH
 *   OCT_STATUS_UNSUPPORTED       → RUNTIME_UNAVAILABLE
 *   OCT_STATUS_VERSION_MISMATCH  → RUNTIME_UNAVAILABLE
 *   OCT_STATUS_CANCELLED         → CANCELLED
 *   OCT_STATUS_TIMEOUT           → REQUEST_TIMEOUT
 *   OCT_STATUS_BUSY              → SERVER_ERROR
 *   any other terminal           → INFERENCE_FAILED
 */

import { RuntimeCapability } from "../../_generated/runtime_capability.js";
import { OctomilError } from "../../types.js";
import {
  NativeModel,
  NativeRuntime,
  NativeRuntimeError,
  NativeSession,
  OCT_EVENT_ERROR,
  OCT_EVENT_METRIC,
  OCT_EVENT_NONE,
  OCT_EVENT_SESSION_COMPLETED,
  OCT_EVENT_SESSION_STARTED,
  OCT_EVENT_TTS_AUDIO_CHUNK,
  OCT_SAMPLE_FORMAT_PCM_F32LE,
  OCT_STATUS_INVALID_INPUT,
  OCT_STATUS_OK,
} from "./loader.js";

// ── Constants ─────────────────────────────────────────────────────────────

const BACKEND_NAME = "native-sherpa-onnx-tts-stream";
const DEFAULT_DEADLINE_MS = 300_000; // 5 minutes
const TTS_MODEL_ENV = "OCTOMIL_SHERPA_TTS_MODEL";
/** Canonical metric name for progressive first-audio-chunk timing (v0.1.9). */
export const TTS_FIRST_AUDIO_MS_METRIC_NAME = "tts.first_audio_ms";

// ── Types ─────────────────────────────────────────────────────────────────

export type TtsStreamingMode = "progressive" | "coalesced";

export interface TtsAudioChunk {
  /** Raw PCM data as Float32Array (mono, PCM_F32LE). */
  pcmF32: Float32Array;
  sampleRateHz: number;
  chunkIndex: number;
  isFinal: boolean;
  cumulativeDurationMs: number;
  /** v0.1.9: "progressive" when worker-thread Generate is active. */
  streamingMode: TtsStreamingMode;
}

// ── Error helper ─────────────────────────────────────────────────────────

function runtimeStatusToSdkError(
  status: number,
  message: string,
  lastError = "",
): OctomilError {
  if (status === 3 /* NOT_FOUND */) {
    return new OctomilError("MODEL_NOT_FOUND", message);
  }
  if (status === 1 /* INVALID_INPUT */) {
    return new OctomilError("INVALID_INPUT", lastError ? `${message}: ${lastError}` : message);
  }
  if (status === 2 /* UNSUPPORTED */) {
    if (lastError.toLowerCase().includes("digest")) {
      return new OctomilError(
        "CHECKSUM_MISMATCH",
        lastError ? `${message}: ${lastError}` : message,
      );
    }
    return new OctomilError("RUNTIME_UNAVAILABLE", lastError ? `${message}: ${lastError}` : message);
  }
  if (status === 8 /* VERSION_MISMATCH */) {
    return new OctomilError("RUNTIME_UNAVAILABLE", message);
  }
  if (status === 6 /* CANCELLED */) {
    return new OctomilError("CANCELLED", message);
  }
  if (status === 5 /* TIMEOUT */) {
    return new OctomilError("REQUEST_TIMEOUT", message);
  }
  if (status === 4 /* BUSY */) {
    return new OctomilError("SERVER_ERROR", message);
  }
  return new OctomilError("INFERENCE_FAILED", lastError ? `${message}: ${lastError}` : message);
}

// ── NativeTtsStreamBackend ────────────────────────────────────────────────

/**
 * Hard-cut audio.tts.stream backend.
 *
 * LIVE_NATIVE_CONDITIONAL — runtime must advertise the capability before
 * any synthesis is attempted.
 *
 * Lifecycle mirrors Python:
 *   loadModel() → opens runtime, verifies capability, opens + warms model.
 *   synthesizeWithChunks() → one session per request, progressive chunks.
 *   close() → shuts down model then runtime.
 */
export class NativeTtsStreamBackend {
  static readonly name = BACKEND_NAME;
  static readonly DEFAULT_DEADLINE_MS = DEFAULT_DEADLINE_MS;

  private _modelName = "";
  private _runtime: NativeRuntime | null = null;
  private _model: NativeModel | null = null;
  private readonly _defaultDeadlineMs: number;

  constructor(opts: { defaultDeadlineMs?: number } = {}) {
    this._defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * Open runtime, verify audio.tts.stream advertised, open + warm sherpa model.
   * Idempotent when called with the same modelName.
   */
  loadModel(
    modelName: string,
    opts: { artifactDigest?: string; modelPath?: string } = {},
  ): void {
    if (this._runtime !== null && this._modelName === modelName) return;
    this.close();
    this._modelName = modelName;

    if (opts.modelPath) {
      process.env[TTS_MODEL_ENV] = opts.modelPath;
    }

    try {
      this._runtime = NativeRuntime.open();
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native TTS-stream backend failed to open runtime",
          err.lastError,
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `native TTS-stream backend: dylib not found (${(err as Error).message ?? err})`,
      );
    }

    if (!runtimeAdvertisesTtsStream(this._runtime)) {
      const lastErr = (this._runtime.lastError() ?? "").toLowerCase();
      this.close();
      if (lastErr.includes("digest")) {
        throw new OctomilError(
          "CHECKSUM_MISMATCH",
          "native TTS-stream backend: sherpa-onnx TTS model SHA-256 does not match " +
            "the canonical pin. Re-download the artifact.",
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "native TTS-stream backend: runtime does not advertise 'audio.tts.stream'. " +
          "Check OCTOMIL_SHERPA_TTS_MODEL (must point at the pinned VITS .onnx with sibling " +
          "tokens.txt + espeak-ng-data/) and that the dylib was built with OCT_HAVE_SHERPA_ONNX_TTS.",
      );
    }

    const resolvedModelPath = opts.modelPath ?? process.env[TTS_MODEL_ENV] ?? "";
    if (!resolvedModelPath) {
      this.close();
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `native TTS-stream backend: ${TTS_MODEL_ENV} not set.`,
      );
    }

    try {
      this._model = this._runtime.openModel({
        modelUri: resolvedModelPath,
        engineHint: "sherpa_onnx",
        artifactDigest: opts.artifactDigest,
      });
      this._model.warm();
    } catch (err) {
      this.close();
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native TTS-stream backend failed to warm sherpa-onnx model",
          err.lastError,
        );
      }
      throw err;
    }
  }

  /**
   * Validate voice: must be a non-negative integer string or null/empty (→ "0").
   * Mirrors Python's validate_voice — raises INVALID_INPUT before any audio.
   */
  validateVoice(voice: string | null | undefined): string {
    if (voice == null || voice === "") return "0";
    const v = voice.trim();
    if (!v) return "0";
    if (!/^\d+$/.test(v)) {
      throw new OctomilError(
        "INVALID_INPUT",
        `native TTS-stream: voice ${JSON.stringify(voice)} is not a non-negative integer sid string. ` +
          "sherpa-onnx accepts numeric speaker ids only at the runtime ABI; pass voice=\"0\" for the model default.",
      );
    }
    return v;
  }

  close(): void {
    if (this._model !== null) {
      try {
        this._model.close();
      } catch {
        /* best-effort */
      }
      this._model = null;
    }
    if (this._runtime !== null) {
      try {
        this._runtime.close();
      } catch {
        /* best-effort */
      }
      this._runtime = null;
    }
  }

  /**
   * Yield sentence-bounded TTS chunks progressively during synthesis.
   *
   * voice validation and send_text happen synchronously before the first
   * chunk is yielded so INVALID_INPUT surfaces before the consumer sees audio.
   *
   * Mirrors Python synthesize_with_chunks().
   */
  *synthesizeWithChunks(
    text: string,
    opts: {
      voiceId?: string | null;
      deadlineMs?: number;
      speed?: number;
    } = {},
  ): IterableIterator<TtsAudioChunk> {
    if (this._runtime === null) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "NativeTtsStreamBackend.synthesizeWithChunks called before loadModel",
      );
    }
    if (this._model === null) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "NativeTtsStreamBackend.synthesizeWithChunks: model not warmed; loadModel() must succeed first",
      );
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new OctomilError("INVALID_INPUT", "native TTS-stream: text must be a non-empty string");
    }

    const resolvedDeadlineMs = opts.deadlineMs ?? this._defaultDeadlineMs;
    if (resolvedDeadlineMs <= 0) {
      throw new OctomilError(
        "INVALID_INPUT",
        `deadline_ms must be > 0; got ${resolvedDeadlineMs}.`,
      );
    }

    const speakerIdStr = this.validateVoice(opts.voiceId);

    let sess: NativeSession;
    try {
      sess = this._runtime.openSession({
        capability: RuntimeCapability.AudioTtsStream,
        locality: "on_device",
        policyPreset: "private",
        speakerId: speakerIdStr,
        model: this._model,
      });
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native TTS-stream backend failed to open session",
          err.lastError,
        );
      }
      throw err;
    }

    // send_text is synchronous — must happen before yielding so INVALID_INPUT
    // lands before the consumer sees any audio (mirrors Python Codex r2 P2 fix).
    try {
      sess.sendText(text);
    } catch (err) {
      sess.close();
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native TTS-stream send_text failed",
          err.lastError,
        );
      }
      throw err;
    }

    yield* this._drain(sess, resolvedDeadlineMs);
  }

  /**
   * Async generator variant over synthesizeWithChunks.
   * Suitable for SSE / streaming response contexts.
   */
  async *synthesizeStream(
    text: string,
    opts: { voice?: string | null; speed?: number } = {},
  ): AsyncIterableIterator<{ pcmF32: Float32Array; sampleRate: number }> {
    // Run the synchronous generator in the current tick; yield async.
    for (const chunk of this.synthesizeWithChunks(text, { voiceId: opts.voice, speed: opts.speed })) {
      yield { pcmF32: chunk.pcmF32, sampleRate: chunk.sampleRateHz };
    }
  }

  private *_drain(
    sess: NativeSession,
    resolvedDeadlineMs: number,
  ): IterableIterator<TtsAudioChunk> {
    try {
      let chunkIndex = 0;
      let cumulativeSamples = 0;
      let cumulativeSampleRate = 0;
      let sawFinalChunk = false;
      let sawError = false;
      let errorMessage = "";
      let terminalStatus = OCT_STATUS_OK;

      const deadline = Date.now() + resolvedDeadlineMs;
      while (Date.now() < deadline) {
        let ev;
        try {
          ev = sess.pollEvent(200);
        } catch (err) {
          if (err instanceof NativeRuntimeError) {
            throw runtimeStatusToSdkError(
              err.status ?? 7,
              "native TTS-stream poll_event failed",
              err.lastError,
            );
          }
          throw err;
        }

        if (ev.type === OCT_EVENT_NONE) continue;
        if (ev.type === OCT_EVENT_SESSION_STARTED) continue;
        if (ev.type === OCT_EVENT_TTS_AUDIO_CHUNK) {
          const tts = ev.ttsAudioChunk;
          if (!tts) continue;
          if (tts.sampleFormat !== OCT_SAMPLE_FORMAT_PCM_F32LE) {
            throw new OctomilError(
              "INVALID_INPUT",
              `native TTS-stream: unexpected sample_format ${tts.sampleFormat} (expected PCM_F32LE)`,
            );
          }
          if (tts.channels !== 1) {
            throw new OctomilError(
              "INVALID_INPUT",
              `native TTS-stream: unexpected channels ${tts.channels} (expected mono=1)`,
            );
          }
          if (tts.sampleRate <= 0) {
            throw new OctomilError(
              "INFERENCE_FAILED",
              "native TTS-stream: zero / negative sample_rate on chunk",
            );
          }
          const pcmF32 = new Float32Array(tts.pcm.buffer, tts.pcm.byteOffset, tts.pcm.byteLength / 4);
          cumulativeSamples += pcmF32.length;
          cumulativeSampleRate = tts.sampleRate;
          const isFinal = tts.isFinal;
          const cumulativeDurationMs =
            cumulativeSampleRate > 0
              ? Math.floor((cumulativeSamples * 1000) / cumulativeSampleRate)
              : 0;

          const chunk: TtsAudioChunk = {
            pcmF32: pcmF32.slice(),
            sampleRateHz: cumulativeSampleRate,
            chunkIndex,
            isFinal,
            cumulativeDurationMs,
            streamingMode: "progressive",
          };
          chunkIndex += 1;
          if (isFinal) sawFinalChunk = true;
          yield chunk;
          continue;
        }
        if (ev.type === OCT_EVENT_ERROR) {
          sawError = true;
          if (!errorMessage) {
            try {
              errorMessage = this._runtime!.lastError();
            } catch {
              /* ignore */
            }
          }
          continue;
        }
        if (ev.type === OCT_EVENT_METRIC) continue;
        if (ev.type === OCT_EVENT_SESSION_COMPLETED) {
          terminalStatus = ev.sessionCompleted?.terminalStatus ?? 0;
          break;
        }
      }

      if (Date.now() >= deadline) {
        throw new OctomilError(
          "REQUEST_TIMEOUT",
          `native TTS-stream backend timed out waiting for SESSION_COMPLETED (${resolvedDeadlineMs}ms)`,
        );
      }

      if (sawError || terminalStatus !== OCT_STATUS_OK) {
        throw runtimeStatusToSdkError(
          terminalStatus !== OCT_STATUS_OK ? terminalStatus : OCT_STATUS_INVALID_INPUT,
          "native TTS-stream backend reported error during synthesis",
          errorMessage,
        );
      }
      if (!sawFinalChunk) {
        throw new OctomilError(
          "INFERENCE_FAILED",
          "native TTS-stream: SESSION_COMPLETED(OK) without a preceding TTS_AUDIO_CHUNK with is_final=1",
        );
      }
    } finally {
      sess.close();
    }
  }
}

export function runtimeAdvertisesTtsStream(rt: NativeRuntime): boolean {
  try {
    const caps = rt.capabilities();
    return caps.supportedCapabilities.includes(RuntimeCapability.AudioTtsStream);
  } catch {
    return false;
  }
}

export { BACKEND_NAME as TTS_STREAM_BACKEND_NAME };
