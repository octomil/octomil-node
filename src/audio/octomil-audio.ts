/**
 * OctomilAudio — namespace for audio APIs on the client.
 */

import { AudioTranscriptions } from "./audio-transcriptions.js";
import type { RuntimeResolver } from "./audio-transcriptions.js";

export class OctomilAudio {
  readonly transcriptions: AudioTranscriptions;

  constructor(runtimeResolver: RuntimeResolver) {
    this.transcriptions = new AudioTranscriptions(runtimeResolver);
  }
}
