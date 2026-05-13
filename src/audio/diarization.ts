/**
 * FacadeDiarization — high-level audio.diarization facade.
 *
 * Mirrors octomil-python/octomil/audio/diarization.py.
 * Wraps NativeDiarizationBackend.
 *
 * Fail-closed: if the runtime is absent or doesn't advertise
 * audio.diarization, raises OctomilError with RUNTIME_UNAVAILABLE.
 */

import {
  NativeDiarizationBackend,
  type DiarizationSegment,
} from "../runtime/native/diarization_backend.js";

export type { DiarizationSegment } from "../runtime/native/diarization_backend.js";

export interface DiarizeOptions {
  /** Sample rate of the audio. Must be 16000 in v0.1.5. */
  sampleRateHz?: number;
  /** Per-request deadline in ms. Defaults to 5 minutes. */
  deadlineMs?: number;
}

// ── FacadeDiarization ─────────────────────────────────────────────────────

/**
 * Speaker diarization facade.
 *
 * Usage:
 * ```ts
 * const diarization = new FacadeDiarization();
 * const segments = diarization.diarize(pcmF32, { sampleRateHz: 16000 });
 * for (const seg of segments) {
 *   console.log(`${seg.speakerLabel}: ${seg.startMs}ms–${seg.endMs}ms`);
 * }
 * ```
 *
 * Fail-closed: if the runtime is unavailable or artifacts are missing,
 * diarize() throws OctomilError with RUNTIME_UNAVAILABLE.
 */
export class FacadeDiarization {
  private readonly _backend: NativeDiarizationBackend;

  constructor() {
    this._backend = new NativeDiarizationBackend();
  }

  /**
   * Diarize a full audio clip. Single-utterance per call.
   *
   * Returns an array of DiarizationSegment objects, one per speaker turn.
   * speakerIsUnknown is true when the speaker could not be identified.
   *
   * Mirrors Python:
   *   backend = NativeDiarizationBackend()
   *   backend.open()
   *   segments = backend.diarize(audio, sample_rate_hz=16000)
   */
  diarize(
    audio: Float32Array | number[],
    opts: DiarizeOptions = {},
  ): DiarizationSegment[] {
    return this._backend.diarize(audio, {
      sampleRateHz: opts.sampleRateHz,
      deadlineMs: opts.deadlineMs,
    });
  }

  close(): void {
    this._backend.close();
  }
}
