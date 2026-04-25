/**
 * AudioSpeech — hosted text-to-speech surface.
 *
 * Mirrors OpenAI's ``client.audio.speech.create(...)`` shape. Posts to
 * the hosted ``{base}/audio/speech`` endpoint where ``{base}`` is the
 * canonical hosted root (``https://api.octomil.com/v1``).
 *
 * v0.10.0 hosted API cutover: legacy control-plane bases (``/api/v1``)
 * are rejected at construction time; no silent normalization.
 */

import { OctomilError } from "../types.js";

// Path is relative to the hosted /v1 API root.
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
  private readonly hostedBase: string;
  private readonly apiKey: string;

  constructor(options: AudioSpeechOptions) {
    if (!options.serverUrl) {
      throw new OctomilError(
        "INVALID_INPUT",
        "AudioSpeech requires a serverUrl. Construct OctomilClient with serverUrl/apiKey for hosted speech.",
      );
    }
    const trimmed = options.serverUrl.replace(/\/+$/, "");
    if (/\/api(\/v1)?$/.test(trimmed)) {
      throw new OctomilError(
        "INVALID_INPUT",
        `Legacy control-plane base URLs are not supported by hosted clients; ` +
          `got '${options.serverUrl}'. Use https://api.octomil.com/v1.`,
      );
    }
    // Canonical hosted base ends in /v1; append it if the caller passed
    // the bare host (the legacy OctomilClient default).
    this.hostedBase = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
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

    let resp: Response;
    try {
      resp = await fetch(this.hostedBase + SPEECH_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (cause) {
      // DNS, offline, TLS, connection reset, abort — surface as a stable
      // network error so callers checking `error.code` see the same
      // contract as audio.transcriptions.
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Hosted speech network failure: ${(cause as Error)?.message ?? cause}`,
        cause,
      );
    }

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
