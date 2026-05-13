/**
 * NativeSpeakerEmbeddingBackend — audio.speaker.embedding via octomil-runtime v0.1.5+.
 *
 * Hard-cutover backend for local speaker embedding extraction via the
 * sherpa-onnx ERes2NetV2 adapter.
 * Mirrors octomil-python/octomil/runtime/native/speaker_backend.py.
 *
 * The runtime advertises audio.speaker.embedding only when:
 *   1. Built with OCT_ENABLE_ENGINE_SHERPA_ONNX=ON.
 *   2. OCTOMIL_SHERPA_SPEAKER_MODEL points at the ERes2NetV2 .onnx
 *      (SHA-256 1a331345…7a5e4b, ~40 MB).
 *
 * When any gate fails, this binding fail-closes with RUNTIME_UNAVAILABLE.
 * There is no TypeScript fallback — speaker embedding is new in v0.1.5.
 *
 * Bounded-error mapping matches Python's audio-backend policy (same as VAD):
 *   OCT_STATUS_NOT_FOUND         → MODEL_NOT_FOUND
 *   OCT_STATUS_INVALID_INPUT     → INVALID_INPUT
 *   OCT_STATUS_UNSUPPORTED w/ "digest" in lastError → CHECKSUM_MISMATCH
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
  OCT_EVENT_EMBEDDING_VECTOR,
  OCT_EVENT_ERROR,
  OCT_EVENT_NONE,
  OCT_EVENT_SESSION_COMPLETED,
  OCT_EVENT_SESSION_STARTED,
  OCT_STATUS_INVALID_INPUT,
  OCT_STATUS_OK,
} from "./loader.js";

// ── Constants ─────────────────────────────────────────────────────────────

const BACKEND_NAME = "native-sherpa-speaker";
const SPEAKER_SAMPLE_RATE_HZ = 16000;
const DEFAULT_DEADLINE_MS = 300_000; // 5 minutes
const SHERPA_SPEAKER_BIN_ENV = "OCTOMIL_SHERPA_SPEAKER_MODEL";
const SUPPORTED_MODEL_NAME = "sherpa-eres2netv2-base";

// ── Types ─────────────────────────────────────────────────────────────────

export interface SpeakerEmbeddingResult {
  values: Float32Array;
  nDim: number;
  isNormalized: boolean;
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

// ── Input validation ──────────────────────────────────────────────────────

function validateClipPcmF32(
  samples: Float32Array | number[],
  sampleRateHz: number,
): Float32Array {
  if (sampleRateHz !== SPEAKER_SAMPLE_RATE_HZ) {
    throw new OctomilError(
      "INVALID_INPUT",
      `native speaker.embedding: sample_rate_hz must be ${SPEAKER_SAMPLE_RATE_HZ} ` +
        `(sherpa speaker is mono-16kHz-only in v0.1.5); got ${sampleRateHz}`,
    );
  }
  const arr =
    samples instanceof Float32Array ? samples : new Float32Array(samples);
  if (arr.length === 0) {
    throw new OctomilError("INVALID_INPUT", "native speaker.embedding: zero-length audio buffer");
  }
  for (let i = 0; i < arr.length; i += 1) {
    if (!isFinite(arr[i] as number)) {
      throw new OctomilError(
        "INVALID_INPUT",
        "native speaker.embedding: audio contains NaN or Inf samples",
      );
    }
  }
  return arr;
}

// ── NativeSpeakerEmbeddingBackend ────────────────────────────────────────

/**
 * Hard-cut audio.speaker.embedding backend backed by octomil-runtime v0.1.5+.
 *
 * Lifecycle mirrors Python: loadModel() opens + warms the runtime and sherpa
 * model handle; each embed() call opens a fresh session, sends the audio,
 * drains until OCT_EVENT_EMBEDDING_VECTOR + OCT_EVENT_SESSION_COMPLETED(OK),
 * then closes the session. The model stays warm between embed() calls.
 */
export class NativeSpeakerEmbeddingBackend {
  static readonly name = BACKEND_NAME;
  static readonly DEFAULT_DEADLINE_MS = DEFAULT_DEADLINE_MS;

  private _loadedModelName = "";
  private _runtime: NativeRuntime | null = null;
  private _model: NativeModel | null = null;
  private readonly _defaultDeadlineMs: number;

  constructor(opts: { defaultDeadlineMs?: number } = {}) {
    this._defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  /**
   * Open runtime, verify audio.speaker.embedding advertised, warm the sherpa model.
   * Idempotent when called with the same model_name.
   */
  loadModel(modelName = SUPPORTED_MODEL_NAME): void {
    if (modelName.toLowerCase() !== SUPPORTED_MODEL_NAME) {
      throw new OctomilError(
        "UNSUPPORTED_MODALITY",
        `native speaker.embedding backend: model ${JSON.stringify(modelName)} is not ` +
          `supported in v0.1.5. Only ${JSON.stringify(SUPPORTED_MODEL_NAME)} is wired in ` +
          "this release (the runtime pins a single ERes2NetV2 SHA-256). " +
          "Multi-model speaker embedding requires a runtime update.",
      );
    }
    if (this._runtime !== null && this._loadedModelName === modelName) return;

    this._loadedModelName = modelName;
    try {
      this._runtime = NativeRuntime.open();
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native speaker.embedding backend failed to open runtime",
          err.lastError,
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `native speaker.embedding backend: dylib not found (${(err as Error).message ?? err})`,
      );
    }

    if (!runtimeAdvertisesAudioSpeakerEmbedding(this._runtime)) {
      const probeLastError = this._probeUnsupportedReason();
      this.close();
      if (probeLastError.toLowerCase().includes("digest")) {
        throw new OctomilError(
          "CHECKSUM_MISMATCH",
          "native speaker.embedding backend: ERes2NetV2 SHA-256 does not match " +
            "the v0.1.5 runtime-pinned digest (1a331345…7a5e4b). " +
            `Re-download the artifact. Runtime diagnostic: ${probeLastError}`,
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "native speaker.embedding backend: runtime does not advertise " +
          "'audio.speaker.embedding'. Check OCTOMIL_SHERPA_SPEAKER_MODEL " +
          "(must point at the ERes2NetV2 ONNX with SHA-256 1a331345…7a5e4b) " +
          "and that the dylib was built with OCT_ENABLE_ENGINE_SHERPA_ONNX=ON. " +
          `Runtime diagnostic: ${probeLastError}`,
      );
    }

    const speakerBin = process.env[SHERPA_SPEAKER_BIN_ENV] ?? "";
    if (!speakerBin) {
      this.close();
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `native speaker.embedding backend: ${SHERPA_SPEAKER_BIN_ENV} not set. ` +
          "Point at a verified ERes2NetV2 .onnx (SHA-256 1a331345…7a5e4b).",
      );
    }

    try {
      this._model = this._runtime.openModel({
        modelUri: speakerBin,
        engineHint: "sherpa_onnx",
      });
      this._model.warm();
    } catch (err) {
      this.close();
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native speaker.embedding backend failed to warm sherpa model",
          err.lastError,
        );
      }
      throw err;
    }
  }

  /**
   * Compute a speaker embedding for the given audio clip.
   * Single-utterance: opens session, sends clip, drains EMBEDDING_VECTOR + COMPLETED.
   */
  embed(
    audio: Float32Array | number[],
    opts: { sampleRateHz?: number; deadlineMs?: number } = {},
  ): SpeakerEmbeddingResult {
    if (this._runtime === null || this._model === null) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "NativeSpeakerEmbeddingBackend.embed called before loadModel",
      );
    }

    const sampleRateHz = opts.sampleRateHz ?? SPEAKER_SAMPLE_RATE_HZ;
    const resolvedDeadlineMs = opts.deadlineMs ?? this._defaultDeadlineMs;
    if (resolvedDeadlineMs <= 0) {
      throw new OctomilError(
        "INVALID_INPUT",
        `deadline_ms must be > 0; got ${resolvedDeadlineMs}.`,
      );
    }

    const validated = validateClipPcmF32(audio, sampleRateHz);

    let sess;
    try {
      sess = this._runtime.openSession({
        capability: RuntimeCapability.AudioSpeakerEmbedding,
        locality: "on_device",
        policyPreset: "private",
        sampleRateIn: sampleRateHz,
        model: this._model,
      });
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native speaker.embedding backend failed to open session",
          err.lastError,
        );
      }
      throw err;
    }

    try {
      try {
        sess.sendAudio(validated, sampleRateHz, 1);
      } catch (err) {
        if (err instanceof NativeRuntimeError) {
          throw runtimeStatusToSdkError(
            err.status ?? 7,
            "native speaker.embedding backend send_audio failed",
            err.lastError,
          );
        }
        throw err;
      }

      let embeddingValues: number[] = [];
      let embeddingNDim = 0;
      let embeddingIsNormalized = false;
      let terminalStatus = OCT_STATUS_OK;
      let sawError = false;
      let errorMessage = "";
      let sawEmbedding = false;

      const deadline = Date.now() + resolvedDeadlineMs;
      while (Date.now() < deadline) {
        let ev;
        try {
          ev = sess.pollEvent(200);
        } catch (err) {
          if (err instanceof NativeRuntimeError) {
            throw runtimeStatusToSdkError(
              err.status ?? 7,
              "native speaker.embedding backend poll_event failed",
              err.lastError,
            );
          }
          throw err;
        }

        if (ev.type === OCT_EVENT_NONE) continue;
        if (ev.type === OCT_EVENT_SESSION_STARTED) continue;
        if (ev.type === OCT_EVENT_EMBEDDING_VECTOR) {
          if (sawEmbedding) {
            throw new OctomilError(
              "INFERENCE_FAILED",
              "native speaker.embedding: runtime emitted multiple EMBEDDING_VECTOR events " +
                "for a single-utterance session",
            );
          }
          const emb = ev.embeddingVector;
          if (!emb) continue;
          embeddingValues = emb.values;
          embeddingNDim = emb.nDim;
          embeddingIsNormalized = emb.isNormalized;
          if (embeddingNDim <= 0 || embeddingValues.length !== embeddingNDim) {
            throw new OctomilError(
              "INFERENCE_FAILED",
              `native speaker.embedding: malformed embedding event ` +
                `(n_dim=${embeddingNDim}, len(values)=${embeddingValues.length})`,
            );
          }
          sawEmbedding = true;
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
        if (ev.type === OCT_EVENT_SESSION_COMPLETED) {
          terminalStatus = ev.sessionCompleted?.terminalStatus ?? 0;
          break;
        }
      }

      if (Date.now() >= deadline) {
        throw new OctomilError(
          "REQUEST_TIMEOUT",
          `native speaker.embedding backend timed out waiting for SESSION_COMPLETED (${resolvedDeadlineMs}ms)`,
        );
      }

      if (sawError || terminalStatus !== OCT_STATUS_OK) {
        throw runtimeStatusToSdkError(
          terminalStatus !== OCT_STATUS_OK ? terminalStatus : OCT_STATUS_INVALID_INPUT,
          "native speaker.embedding backend reported error during inference",
          errorMessage,
        );
      }
      if (!sawEmbedding) {
        throw new OctomilError(
          "INFERENCE_FAILED",
          "native speaker.embedding: SESSION_COMPLETED(OK) without preceding EMBEDDING_VECTOR",
        );
      }

      return {
        values: new Float32Array(embeddingValues),
        nDim: embeddingNDim,
        isNormalized: embeddingIsNormalized,
      };
    } finally {
      sess.close();
    }
  }

  private _probeUnsupportedReason(): string {
    if (this._runtime === null) return "";
    try {
      const sess = this._runtime.openSession({
        capability: RuntimeCapability.AudioSpeakerEmbedding,
        locality: "on_device",
        policyPreset: "private",
        sampleRateIn: SPEAKER_SAMPLE_RATE_HZ,
      });
      try {
        sess.close();
      } catch {
        /* ignore */
      }
      return "";
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        try {
          const full = this._runtime.lastError();
          const short = err.lastError ?? "";
          return full.length >= short.length ? full : short;
        } catch {
          return err.lastError ?? "";
        }
      }
      return "";
    }
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
}

export function runtimeAdvertisesAudioSpeakerEmbedding(rt: NativeRuntime): boolean {
  try {
    const caps = rt.capabilities();
    return caps.supportedCapabilities.includes(RuntimeCapability.AudioSpeakerEmbedding);
  } catch {
    return false;
  }
}

export { BACKEND_NAME as SPEAKER_BACKEND_NAME, SUPPORTED_MODEL_NAME as SPEAKER_SUPPORTED_MODEL_NAME };
