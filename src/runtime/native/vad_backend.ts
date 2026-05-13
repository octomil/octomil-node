/**
 * NativeVadBackend — audio.vad via octomil-runtime v0.1.5+.
 *
 * Hard-cutover backend for local Silero voice-activity-detection.
 * Mirrors octomil-python/octomil/runtime/native/vad_backend.py.
 *
 * The runtime advertises audio.vad only when:
 *   1. Built with OCT_ENABLE_ENGINE_SILERO_VAD=ON.
 *   2. OCTOMIL_SILERO_VAD_MODEL points at ggml-silero-v6.2.0.bin
 *      (SHA-256 2aa269b7…fb6987, ~885 KB).
 *
 * When any gate fails, this binding fail-closes with RUNTIME_UNAVAILABLE.
 * There is no TypeScript fallback — VAD is a new capability surface in v0.1.5.
 *
 * Bounded-error mapping (runtime status → SDK OctomilErrorCode):
 *   OCT_STATUS_NOT_FOUND         → MODEL_NOT_FOUND
 *   OCT_STATUS_INVALID_INPUT     → INVALID_INPUT
 *   OCT_STATUS_UNSUPPORTED w/ "digest" in lastError → CHECKSUM_MISMATCH
 *   OCT_STATUS_UNSUPPORTED       → RUNTIME_UNAVAILABLE
 *   OCT_STATUS_VERSION_MISMATCH  → RUNTIME_UNAVAILABLE
 *   OCT_STATUS_CANCELLED         → CANCELLED
 *   OCT_STATUS_TIMEOUT           → REQUEST_TIMEOUT
 *   OCT_STATUS_BUSY              → SERVER_ERROR (runtime busy)
 *   any other terminal           → INFERENCE_FAILED
 */

import { RuntimeCapability } from "../../_generated/runtime_capability.js";
import { OctomilError } from "../../types.js";
import {
  NativeRuntime,
  NativeRuntimeError,
  NativeSession,
  OCT_EVENT_ERROR,
  OCT_EVENT_NONE,
  OCT_EVENT_SESSION_COMPLETED,
  OCT_EVENT_SESSION_STARTED,
  OCT_EVENT_VAD_TRANSITION,
  OCT_STATUS_OK,
  OCT_VAD_TRANSITION_SPEECH_END,
  OCT_VAD_TRANSITION_SPEECH_START,
} from "./loader.js";

// ── Constants ─────────────────────────────────────────────────────────────

const BACKEND_NAME = "native-silero-vad";
const VAD_SAMPLE_RATE_HZ = 16000;
const DEFAULT_DEADLINE_MS = 300_000; // 5 minutes

// ── Types ─────────────────────────────────────────────────────────────────

export type VadTransitionKind = "speech_start" | "speech_end" | "unknown";

export interface VadTransition {
  kind: VadTransitionKind;
  timestampMs: number;
  confidence: number;
}

// ── Error helper ─────────────────────────────────────────────────────────

function runtimeStatusToSdkError(
  status: number,
  message: string,
  lastError = "",
): OctomilError {
  // Bounded mapping — mirrors Python error_mapping.map_oct_status with
  // default_unsupported_code = RUNTIME_UNAVAILABLE.
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

function validateChunkPcmF32(
  samples: Float32Array | number[],
  sampleRateHz: number,
): Float32Array {
  if (sampleRateHz !== VAD_SAMPLE_RATE_HZ) {
    throw new OctomilError(
      "INVALID_INPUT",
      `native VAD: sample_rate_hz must be ${VAD_SAMPLE_RATE_HZ} ` +
        `(silero VAD is mono-16kHz-only in v0.1.5); got ${sampleRateHz}`,
    );
  }
  const arr =
    samples instanceof Float32Array ? samples : new Float32Array(samples);
  if (arr.length === 0) {
    throw new OctomilError("INVALID_INPUT", "native VAD: zero-length audio buffer");
  }
  // Non-finite check (mirrors Python's NaN/Inf guard).
  for (let i = 0; i < arr.length; i += 1) {
    if (!isFinite(arr[i] as number)) {
      throw new OctomilError(
        "INVALID_INPUT",
        "native VAD: audio contains NaN or Inf samples",
      );
    }
  }
  return arr;
}

// ── VadStreamingSession ───────────────────────────────────────────────────

/**
 * Context-managed streaming wrapper over an audio.vad session.
 *
 * Single-utterance contract: once SESSION_COMPLETED fires, no further
 * feed/poll is valid. Open a fresh VadStreamingSession for the next clip.
 *
 * Mirrors Python's VadStreamingSession (same method names + semantics).
 */
export class VadStreamingSession {
  private _nativeSession: NativeSession | null = null;
  private _closed = false;
  private _terminalSeen = false;
  private readonly _runtime: NativeRuntime;
  private readonly _sampleRateHz: number;

  constructor(runtime: NativeRuntime, sampleRateHz: number) {
    this._runtime = runtime;
    this._sampleRateHz = sampleRateHz;
    try {
      this._nativeSession = runtime.openSession({
        capability: RuntimeCapability.AudioVad,
        locality: "on_device",
        policyPreset: "private",
        sampleRateIn: sampleRateHz,
      });
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native VAD backend failed to open session",
          err.lastError,
        );
      }
      throw err;
    }
  }

  /**
   * Push an audio chunk into the VAD session.
   * Accepts Float32Array or number[]. Rejects NaN/Inf/zero-length/wrong-rate.
   */
  feedChunk(audio: Float32Array | number[], sampleRateHz?: number): void {
    if (this._closed || this._nativeSession === null) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "VadStreamingSession.feedChunk: session is closed",
      );
    }
    const sr = sampleRateHz ?? this._sampleRateHz;
    const validated = validateChunkPcmF32(audio, sr);
    try {
      this._nativeSession.sendAudio(validated, sr, 1);
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native VAD backend send_audio failed",
          err.lastError,
        );
      }
      throw err;
    }
  }

  /**
   * Drain pending VAD transitions from the session.
   *
   * @param opts.deadlineMs  Wall-clock budget (default 5 min).
   * @param opts.drainUntilCompleted  When true, polls until SESSION_COMPLETED.
   * @returns Iterable of VadTransition events.
   */
  *pollTransitions(opts: {
    deadlineMs?: number;
    drainUntilCompleted?: boolean;
  } = {}): IterableIterator<VadTransition> {
    if (this._closed || this._nativeSession === null) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "VadStreamingSession.pollTransitions: session is closed",
      );
    }
    if (this._terminalSeen) return;

    const resolvedDeadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (resolvedDeadlineMs <= 0) {
      throw new OctomilError(
        "INVALID_INPUT",
        `VadStreamingSession.pollTransitions: deadlineMs must be > 0; got ${resolvedDeadlineMs}`,
      );
    }

    const drainUntilCompleted = opts.drainUntilCompleted ?? false;
    const perPollMs = drainUntilCompleted ? 200 : 25;
    const deadline = Date.now() + resolvedDeadlineMs;

    while (Date.now() < deadline) {
      let ev;
      try {
        ev = this._nativeSession.pollEvent(perPollMs);
      } catch (err) {
        if (err instanceof NativeRuntimeError) {
          throw runtimeStatusToSdkError(
            err.status ?? 7,
            "native VAD backend poll_event failed",
            err.lastError,
          );
        }
        throw err;
      }

      if (ev.type === OCT_EVENT_NONE) {
        if (!drainUntilCompleted) return;
        continue;
      }
      if (ev.type === OCT_EVENT_SESSION_STARTED) continue;
      if (ev.type === OCT_EVENT_VAD_TRANSITION) {
        const vad = ev.vadTransition;
        if (!vad) continue;
        const kind = kindLabel(vad.transitionKind);
        // Future-compat: skip unknown transitions rather than crash.
        if (kind === "unknown") continue;
        yield { kind, timestampMs: vad.timestampMs, confidence: vad.confidence };
        continue;
      }
      if (ev.type === OCT_EVENT_ERROR) continue;
      if (ev.type === OCT_EVENT_SESSION_COMPLETED) {
        this._terminalSeen = true;
        const terminal = ev.sessionCompleted?.terminalStatus ?? 0;
        if (terminal !== OCT_STATUS_OK) {
          let lastErr = "";
          try {
            lastErr = this._runtime.lastError();
          } catch {
            /* ignore */
          }
          throw runtimeStatusToSdkError(
            terminal,
            "native VAD backend session terminated with non-OK status",
            lastErr,
          );
        }
        return;
      }
    }

    if (drainUntilCompleted) {
      throw new OctomilError(
        "REQUEST_TIMEOUT",
        `VadStreamingSession.pollTransitions: timed out after ${resolvedDeadlineMs} ms waiting for SESSION_COMPLETED`,
      );
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    const sess = this._nativeSession;
    this._nativeSession = null;
    if (sess !== null) {
      try {
        sess.close();
      } catch {
        /* best-effort */
      }
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }
}

function kindLabel(transitionKind: number): VadTransitionKind {
  if (transitionKind === OCT_VAD_TRANSITION_SPEECH_START) return "speech_start";
  if (transitionKind === OCT_VAD_TRANSITION_SPEECH_END) return "speech_end";
  return "unknown";
}

// ── NativeVadBackend ──────────────────────────────────────────────────────

/**
 * Hard-cut audio.vad backend backed by octomil-runtime v0.1.5+.
 *
 * Mirrors Python's NativeVadBackend. Each openSession() call returns a
 * VadStreamingSession. No model handle is required (VAD is model-less in
 * v0.1.5 — the runtime loads the silero bin per-session internally).
 *
 * Fail-closed semantics:
 *   - If the runtime doesn't advertise audio.vad, raises RUNTIME_UNAVAILABLE
 *     (or CHECKSUM_MISMATCH when the digest gate fails).
 *   - Never falls back to a JS/TS implementation.
 */
export class NativeVadBackend {
  static readonly name = BACKEND_NAME;

  private _runtime: NativeRuntime | null = null;
  private _initialized = false;

  /**
   * Open the underlying runtime and verify audio.vad is advertised.
   * Idempotent.
   */
  open(): void {
    if (this._initialized) return;
    try {
      this._runtime = NativeRuntime.open();
    } catch (err) {
      if (err instanceof NativeRuntimeError) {
        throw runtimeStatusToSdkError(
          err.status ?? 7,
          "native VAD backend failed to open runtime",
          err.lastError,
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `native VAD backend: dylib not found (${(err as Error).message ?? err})`,
      );
    }

    if (!runtimeAdvertisesAudioVad(this._runtime)) {
      const probeLastError = this._probeUnsupportedReason();
      this.close();
      if (probeLastError.toLowerCase().includes("digest")) {
        throw new OctomilError(
          "CHECKSUM_MISMATCH",
          "native VAD backend: ggml-silero-v6.2.0.bin SHA-256 does not match " +
            "the v0.1.5 runtime-pinned digest (2aa269b7…fb6987). " +
            `Re-download the artifact. Runtime diagnostic: ${probeLastError}`,
        );
      }
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "native VAD backend: runtime does not advertise 'audio.vad'. " +
          "Check OCTOMIL_SILERO_VAD_MODEL (must point at ggml-silero-v6.2.0.bin " +
          "with SHA-256 2aa269b7…fb6987) and that the dylib was built with " +
          `OCT_ENABLE_ENGINE_SILERO_VAD=ON. Runtime diagnostic: ${probeLastError}`,
      );
    }
    this._initialized = true;
  }

  /** Open a streaming VAD session. Calls open() if not yet initialized. */
  openSession(sampleRateHz = VAD_SAMPLE_RATE_HZ): VadStreamingSession {
    if (sampleRateHz !== VAD_SAMPLE_RATE_HZ) {
      throw new OctomilError(
        "INVALID_INPUT",
        `NativeVadBackend: sample_rate_hz must be ${VAD_SAMPLE_RATE_HZ} ` +
          `(silero VAD is mono-16kHz-only in v0.1.5); got ${sampleRateHz}`,
      );
    }
    if (!this._initialized || this._runtime === null) {
      this.open();
    }
    return new VadStreamingSession(this._runtime!, sampleRateHz);
  }

  private _probeUnsupportedReason(): string {
    if (this._runtime === null) return "";
    try {
      const sess = this._runtime.openSession({
        capability: RuntimeCapability.AudioVad,
        locality: "on_device",
        policyPreset: "private",
        sampleRateIn: VAD_SAMPLE_RATE_HZ,
      });
      // Unexpected: probe succeeded — close it.
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

export function runtimeAdvertisesAudioVad(rt: NativeRuntime): boolean {
  try {
    const caps = rt.capabilities();
    return caps.supportedCapabilities.includes(RuntimeCapability.AudioVad);
  } catch {
    return false;
  }
}

export { BACKEND_NAME as VAD_BACKEND_NAME, VAD_SAMPLE_RATE_HZ };
