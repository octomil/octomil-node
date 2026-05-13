/**
 * FacadeVad — high-level audio.vad facade.
 *
 * Mirrors octomil-python/octomil/audio/vad.py.
 * Wraps NativeVadBackend for ease-of-use: detect(audio) returns segments.
 *
 * Fail-closed: if the native runtime is absent or doesn't advertise
 * audio.vad, raises OctomilError with code RUNTIME_UNAVAILABLE (or
 * CHECKSUM_MISMATCH for digest failures).
 */

import type { NativeRuntime } from "../runtime/native/loader.js";
import {
  NativeVadBackend,
  VadStreamingSession,
  type VadTransition,
} from "../runtime/native/vad_backend.js";

export type { VadTransition, VadTransitionKind } from "../runtime/native/vad_backend.js";

export interface VadDetectOptions {
  /** Sample rate of the audio. Must be 16000 for silero VAD in v0.1.5. */
  sampleRateHz?: number;
  /**
   * Wall-clock deadline for draining all transitions.
   * Defaults to 5 minutes.
   */
  deadlineMs?: number;
}

export interface VadSegment {
  /** Start offset in ms from the beginning of the audio window (runtime-monotonic). */
  startMs: number;
  /** End offset in ms. */
  endMs: number;
  /** Average confidence across the speech window, clamped to [0, 1]. */
  confidence: number;
}

// ── FacadeVad ─────────────────────────────────────────────────────────────

/**
 * Voice Activity Detection facade.
 *
 * Usage:
 * ```ts
 * const vad = new FacadeVad();
 * const segments = vad.detect(pcmF32, { sampleRateHz: 16000 });
 * for (const seg of segments) {
 *   console.log(`speech ${seg.startMs}ms–${seg.endMs}ms confidence=${seg.confidence}`);
 * }
 * ```
 *
 * The facade is fail-closed: if the runtime is unavailable or the artifact
 * is missing, detect() throws OctomilError with RUNTIME_UNAVAILABLE.
 */
export class FacadeVad {
  private readonly _backend: NativeVadBackend;

  /**
   * @param opts.runtime  Optional pre-opened NativeRuntime. When omitted the
   *   backend discovers and opens the runtime from env/cache automatically.
   */
  constructor(opts: { runtime?: NativeRuntime } = {}) {
    this._backend = new NativeVadBackend();
    if (opts.runtime) {
      // Allow injection of a pre-opened runtime for testing.
      // NativeVadBackend will open its own on first openSession() if none injected.
      (this._backend as unknown as { _runtime: NativeRuntime })._runtime = opts.runtime;
      (this._backend as unknown as { _initialized: boolean })._initialized = true;
    }
  }

  /**
   * Detect speech segments in the given audio.
   *
   * Equivalent to Python:
   *   backend = NativeVadBackend(); backend.open()
   *   with backend.open_session() as sess:
   *     sess.feed_chunk(audio); yield from sess.poll_transitions(drain_until_completed=True)
   *
   * Returns an array of VadSegment objects derived from paired speech_start /
   * speech_end transitions.
   *
   * NOTE: "unknown" transitions are skipped (future-compat contract).
   */
  detect(
    audio: Float32Array | number[],
    opts: VadDetectOptions = {},
  ): VadSegment[] {
    const sampleRateHz = opts.sampleRateHz ?? 16000;
    const sess = this._backend.openSession(sampleRateHz);
    try {
      sess.feedChunk(audio, sampleRateHz);
      const transitions = Array.from(
        sess.pollTransitions({ deadlineMs: opts.deadlineMs, drainUntilCompleted: true }),
      );
      return segmentsFromTransitions(transitions);
    } finally {
      sess.close();
    }
  }

  /**
   * Open a streaming session for incremental chunk-by-chunk feeding.
   * The caller is responsible for closing the session.
   */
  openStreamingSession(sampleRateHz?: number): VadStreamingSession {
    return this._backend.openSession(sampleRateHz);
  }

  close(): void {
    this._backend.close();
  }
}

// ── Transition → segment conversion ──────────────────────────────────────

/**
 * Pair speech_start/speech_end transitions into [start, end) segments.
 * Unpaired starts at end-of-stream are omitted (runtime contract: the
 * runtime always emits a speech_end before SESSION_COMPLETED).
 */
function segmentsFromTransitions(transitions: VadTransition[]): VadSegment[] {
  const segments: VadSegment[] = [];
  let pendingStart: VadTransition | null = null;
  for (const t of transitions) {
    if (t.kind === "speech_start") {
      pendingStart = t;
    } else if (t.kind === "speech_end" && pendingStart !== null) {
      segments.push({
        startMs: pendingStart.timestampMs,
        endMs: t.timestampMs,
        confidence: (pendingStart.confidence + t.confidence) / 2,
      });
      pendingStart = null;
    }
    // kind === "unknown" — skipped per future-compat contract.
  }
  return segments;
}
