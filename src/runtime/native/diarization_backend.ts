/**
 * NativeDiarizationBackend — audio.diarization via octomil-runtime.
 *
 * audio.diarization is LIVE_NATIVE_CONDITIONAL. The runtime advertises it only
 * when the dylib was built with the sherpa-onnx diarization subset and both
 * ONNX artifact gates pass:
 *   - OCTOMIL_DIARIZATION_SEGMENTATION_MODEL → canonical pyannote segmentation model.onnx
 *   - OCTOMIL_SHERPA_SPEAKER_MODEL → canonical 3D-Speaker embedding extractor ONNX.
 *
 * Mirrors octomil-python/octomil/runtime/native/diarization_backend.py.
 * No TypeScript fallback — raises RUNTIME_UNAVAILABLE if not advertised.
 *
 * Bounded-error mapping (same as other audio backends):
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
  NativeRuntime,
  NativeRuntimeError,
  OCT_DIARIZATION_SPEAKER_UNKNOWN,
  OCT_EVENT_DIARIZATION_SEGMENT,
  OCT_EVENT_ERROR,
  OCT_EVENT_NONE,
  OCT_EVENT_SESSION_COMPLETED,
  OCT_EVENT_SESSION_STARTED,
  OCT_STATUS_OK,
} from "./loader.js";

// ── Constants ─────────────────────────────────────────────────────────────

const BACKEND_NAME = "native-sherpa-diarization";
const DIARIZATION_SAMPLE_RATE_HZ = 16000;
const DEFAULT_DEADLINE_MS = 300_000; // 5 minutes

// ── Types ─────────────────────────────────────────────────────────────────

export interface DiarizationSegment {
  startMs: number;
  endMs: number;
  speakerId: number;
  speakerLabel: string;
  /** True when speakerId === OCT_DIARIZATION_SPEAKER_UNKNOWN (65535). */
  speakerIsUnknown: boolean;
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

function validatePcmF32(
  samples: Float32Array | number[],
  sampleRateHz: number,
): Float32Array {
  if (sampleRateHz !== DIARIZATION_SAMPLE_RATE_HZ) {
    throw new OctomilError(
      "INVALID_INPUT",
      `native diarization: sample_rate_hz must be ${DIARIZATION_SAMPLE_RATE_HZ}; got ${sampleRateHz}`,
    );
  }
  const arr =
    samples instanceof Float32Array ? samples : new Float32Array(samples);
  if (arr.length === 0) {
    throw new OctomilError("INVALID_INPUT", "native diarization: zero-length audio buffer");
  }
  for (let i = 0; i < arr.length; i += 1) {
    if (!isFinite(arr[i] as number)) {
      throw new OctomilError(
        "INVALID_INPUT",
        "native diarization: audio contains NaN or Inf samples",
      );
    }
  }
  return arr;
}

// ── NativeDiarizationBackend ──────────────────────────────────────────────

/**
 * Low-level TypeScript wrapper for the native audio.diarization session.
 *
 * Mirrors Python's NativeDiarizationBackend. Single-utterance per diarize()
 * call: opens a model-less session, sends the full clip, drains all
 * OCT_EVENT_DIARIZATION_SEGMENT events until SESSION_COMPLETED, returns
 * the segment list.
 */
export class NativeDiarizationBackend {
  static readonly name = BACKEND_NAME;

  private _runtime: NativeRuntime | null = null;
  private _initialized = false;

  open(): void {
    if (this._initialized) return;
    try {
      this._runtime = NativeRuntime.open();
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native diarization backend failed to open runtime",
          err.lastError,
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `native diarization backend: dylib not found (${(err as Error).message ?? err})`,
      );
    }

    if (!runtimeAdvertisesAudioDiarization(this._runtime)) {
      this.close();
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "native diarization backend: runtime does not advertise 'audio.diarization'. " +
          "Check that the dylib was built with OCT_ENABLE_ENGINE_DIARIZATION=ON and that " +
          "OCTOMIL_DIARIZATION_SEGMENTATION_MODEL plus OCTOMIL_SHERPA_SPEAKER_MODEL " +
          "point at canonical ONNX files.",
      );
    }
    this._initialized = true;
  }

  /**
   * Diarize a full audio clip. Single-utterance — opens and closes a session per call.
   */
  diarize(
    audio: Float32Array | number[],
    opts: { sampleRateHz?: number; deadlineMs?: number } = {},
  ): DiarizationSegment[] {
    const sampleRateHz = opts.sampleRateHz ?? DIARIZATION_SAMPLE_RATE_HZ;
    const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;

    if (deadlineMs <= 0) {
      throw new OctomilError(
        "INVALID_INPUT",
        `NativeDiarizationBackend.diarize: deadlineMs must be > 0; got ${deadlineMs}`,
      );
    }
    if (!this._initialized || this._runtime === null) {
      this.open();
    }

    const validated = validatePcmF32(audio, sampleRateHz);
    let session;
    try {
      session = this._runtime!.openSession({
        capability: RuntimeCapability.AudioDiarization,
        locality: "on_device",
        policyPreset: "private",
        sampleRateIn: sampleRateHz,
      });
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native diarization backend failed to open session",
          err.lastError,
        );
      }
      throw err;
    }

    const segments: DiarizationSegment[] = [];
    try {
      try {
        session.sendAudio(validated, sampleRateHz, 1);
      } catch (err) {
        if (err instanceof NativeRuntimeError) {
          throw runtimeStatusToSdkError(
            err.status ?? 7,
            "native diarization backend send_audio failed",
            err.lastError,
          );
        }
        throw err;
      }

      const deadline = Date.now() + deadlineMs;
      while (Date.now() < deadline) {
        let ev;
        try {
          ev = session.pollEvent(200);
        } catch (err) {
          if (err instanceof NativeRuntimeError) {
            throw runtimeStatusToSdkError(
              err.status ?? 7,
              "native diarization backend poll_event failed",
              err.lastError,
            );
          }
          throw err;
        }

        if (ev.type === OCT_EVENT_NONE) continue;
        if (ev.type === OCT_EVENT_SESSION_STARTED) continue;
        if (ev.type === OCT_EVENT_DIARIZATION_SEGMENT) {
          const diar = ev.diarizationSegment;
          if (!diar) continue;
          segments.push({
            startMs: diar.startMs,
            endMs: diar.endMs,
            speakerId: diar.speakerId,
            speakerLabel: diar.speakerLabel,
            speakerIsUnknown: diar.speakerId === OCT_DIARIZATION_SPEAKER_UNKNOWN,
          });
          continue;
        }
        if (ev.type === OCT_EVENT_ERROR) continue;
        if (ev.type === OCT_EVENT_SESSION_COMPLETED) {
          const terminal = ev.sessionCompleted?.terminalStatus ?? 0;
          if (terminal !== OCT_STATUS_OK) {
            let lastErr = "";
            try {
              lastErr = this._runtime!.lastError();
            } catch {
              /* ignore */
            }
            throw runtimeStatusToSdkError(
              terminal,
              "native diarization backend session terminated with non-OK status",
              lastErr,
            );
          }
          return segments;
        }
      }

      throw new OctomilError(
        "REQUEST_TIMEOUT",
        `NativeDiarizationBackend.diarize: timed out after ${deadlineMs} ms waiting for SESSION_COMPLETED`,
      );
    } finally {
      try {
        session.close();
      } catch {
        /* best-effort */
      }
    }
  }

  close(): void {
    this._initialized = false;
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

export function runtimeAdvertisesAudioDiarization(rt: NativeRuntime): boolean {
  try {
    const caps = rt.capabilities();
    return caps.supportedCapabilities.includes(RuntimeCapability.AudioDiarization);
  } catch {
    return false;
  }
}

export { BACKEND_NAME as DIARIZATION_BACKEND_NAME };
