/**
 * AudioSpeech — hosted text-to-speech surface.
 *
 * Mirrors OpenAI's ``client.audio.speech.create(...)`` shape and posts to
 * the Octomil hosted ``/v1/audio/speech`` endpoint. Returns the raw audio
 * bytes plus Octomil routing metadata surfaced via ``X-Octomil-*``
 * response headers.
 */

import { OctomilError } from "../types.js";

const SPEECH_PATH = "/audio/speech";

export interface AudioSpeechOptions {
  serverUrl: string;
  apiKey: string;
}

export interface SpeechCreateRequest {
  model: string;
  input: string;
  voice?: string;
  responseFormat?: "mp3" | "wav" | "ogg" | "opus" | "flac" | "aac" | "pcm";
  speed?: number;
}

export interface SpeechResponse {
  audioBytes: Uint8Array;
  contentType: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
  billedUnits?: number;
  unitKind?: string;
}

export class AudioSpeech {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(options: AudioSpeechOptions) {
    if (!options.serverUrl) {
      throw new OctomilError(
        "INVALID_INPUT",
        "AudioSpeech requires a serverUrl. Construct OctomilClient with serverUrl/apiKey for hosted speech.",
      );
    }
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
  }

  async create(request: SpeechCreateRequest): Promise<SpeechResponse> {
    if (!request.input || !request.input.trim()) {
      throw new OctomilError(
        "INVALID_INPUT",
        "`input` must be a non-empty string.",
      );
    }

    const body = {
      model: request.model,
      input: request.input,
      voice: request.voice,
      response_format: request.responseFormat ?? "mp3",
      speed: request.speed ?? 1.0,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const resp = await fetch(this.serverUrl + SPEECH_PATH, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new OctomilError(
        "INFERENCE_FAILED",
        `Hosted speech request failed: ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`,
      );
    }

    const buf = new Uint8Array(await resp.arrayBuffer());
    const latencyRaw = resp.headers.get("x-octomil-latency-ms");
    const billedRaw = resp.headers.get("x-octomil-billed-units");

    return {
      audioBytes: buf,
      contentType:
        resp.headers.get("content-type") ?? "application/octet-stream",
      provider: resp.headers.get("x-octomil-provider") ?? undefined,
      model: resp.headers.get("x-octomil-model") ?? request.model,
      latencyMs: latencyRaw != null ? Number(latencyRaw) : undefined,
      billedUnits: billedRaw != null ? Number(billedRaw) : undefined,
      unitKind: resp.headers.get("x-octomil-unit-kind") ?? undefined,
    };
  }
}
