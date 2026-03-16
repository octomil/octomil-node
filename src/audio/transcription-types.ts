/**
 * Audio transcription types.
 */

export interface TranscriptionSegment {
  readonly text: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence?: number;
}

export interface TranscriptionResult {
  readonly text: string;
  readonly segments: TranscriptionSegment[];
  readonly language?: string;
  readonly durationMs?: number;
}
