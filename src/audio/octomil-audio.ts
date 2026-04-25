/**
 * OctomilAudio — namespace for audio APIs on the client.
 *
 * Constructed in two shapes:
 *   - Local-only:  new OctomilAudio(runtimeResolver)
 *   - Local + hosted: new OctomilAudio({ runtimeResolver, serverUrl, apiKey })
 *
 * `transcriptions` runs through the local runtime resolver (and the planner
 * when serverUrl is provided). `speech` is hosted-only and requires
 * serverUrl/apiKey.
 */

import { AudioTranscriptions } from "./audio-transcriptions.js";
import type { RuntimeResolver } from "./audio-transcriptions.js";
import { AudioSpeech } from "./audio-speech.js";

export interface OctomilAudioOptions {
  runtimeResolver: RuntimeResolver;
  serverUrl?: string;
  apiKey?: string;
}

export class OctomilAudio {
  readonly transcriptions: AudioTranscriptions;
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private _speech: AudioSpeech | null = null;

  constructor(input: RuntimeResolver | OctomilAudioOptions) {
    if (typeof input === "function") {
      this.transcriptions = new AudioTranscriptions(input);
      this.serverUrl = "";
      this.apiKey = "";
    } else {
      this.transcriptions = new AudioTranscriptions({
        runtimeResolver: input.runtimeResolver,
        serverUrl: input.serverUrl,
        apiKey: input.apiKey,
      });
      this.serverUrl = input.serverUrl ?? "";
      this.apiKey = input.apiKey ?? "";
    }
  }

  /**
   * Hosted text-to-speech. Requires serverUrl + apiKey at construction time.
   * Throws on access if neither was provided.
   */
  get speech(): AudioSpeech {
    if (this._speech == null) {
      this._speech = new AudioSpeech({
        serverUrl: this.serverUrl,
        apiKey: this.apiKey,
      });
    }
    return this._speech;
  }
}
