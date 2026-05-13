/**
 * FacadeSpeakerEmbedding — high-level audio.speaker.embedding facade.
 *
 * Mirrors octomil-python/octomil/audio/speaker_embedding.py.
 * Wraps NativeSpeakerEmbeddingBackend.
 *
 * Fail-closed: if the runtime is absent or doesn't advertise
 * audio.speaker.embedding, raises OctomilError with RUNTIME_UNAVAILABLE.
 */

import {
  NativeSpeakerEmbeddingBackend,
  type SpeakerEmbeddingResult,
} from "../runtime/native/speaker_backend.js";

export type { SpeakerEmbeddingResult } from "../runtime/native/speaker_backend.js";

export interface SpeakerEmbedOptions {
  /** Sample rate of the audio. Must be 16000 in v0.1.5. */
  sampleRateHz?: number;
  /** Per-request deadline in ms. Defaults to 5 minutes. */
  deadlineMs?: number;
}

// ── FacadeSpeakerEmbedding ────────────────────────────────────────────────

/**
 * Speaker embedding facade.
 *
 * Usage:
 * ```ts
 * const speaker = new FacadeSpeakerEmbedding();
 * const result = speaker.embed(pcmF32, { sampleRateHz: 16000 });
 * console.log(`embedding dim=${result.nDim}`);
 * ```
 *
 * Fail-closed: if the runtime is unavailable or artifact is missing,
 * embed() throws OctomilError with RUNTIME_UNAVAILABLE or CHECKSUM_MISMATCH.
 */
export class FacadeSpeakerEmbedding {
  private readonly _backend: NativeSpeakerEmbeddingBackend;
  private _loaded = false;

  constructor(opts: { defaultDeadlineMs?: number } = {}) {
    this._backend = new NativeSpeakerEmbeddingBackend({
      defaultDeadlineMs: opts.defaultDeadlineMs,
    });
  }

  /**
   * Compute a speaker embedding for the given audio clip.
   *
   * On first call, loads + warms the model. Subsequent calls reuse the
   * warmed model handle (same lifecycle as Python).
   *
   * Returns a SpeakerEmbeddingResult with:
   *   - values: Float32Array of length nDim (512 for canonical ERes2NetV2 base)
   *   - nDim: embedding dimensionality
   *   - isNormalized: true (L2-normalized in-engine)
   *
   * Mirrors Python:
   *   backend = NativeSpeakerEmbeddingBackend()
   *   backend.load_model()
   *   result = backend.embed(audio, sample_rate_hz=16000)
   */
  embed(
    audio: Float32Array | number[],
    opts: SpeakerEmbedOptions = {},
  ): SpeakerEmbeddingResult {
    if (!this._loaded) {
      this._backend.loadModel();
      this._loaded = true;
    }
    return this._backend.embed(audio, {
      sampleRateHz: opts.sampleRateHz,
      deadlineMs: opts.deadlineMs,
    });
  }

  close(): void {
    this._backend.close();
    this._loaded = false;
  }
}
