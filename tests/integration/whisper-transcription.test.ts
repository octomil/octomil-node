/**
 * Integration test: whisper.cpp audio transcription through the SDK pipeline.
 *
 * Exercises: LocalFileModelRuntime → ModelRuntime → AudioTranscriptions.create()
 * Requires: whisper.cpp built at research/engines/whisper.cpp/build/bin/whisper-cli
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { AudioTranscriptions } from "../../src/audio/audio-transcriptions.js";
import { LocalFileModelRuntime } from "../../src/runtime/engines/local-file-runtime.js";
import { ModelRef } from "../../src/model-ref.js";
import { ModelCapability } from "../../src/_generated/model_capability.js";
import type { ModelRuntime } from "../../src/runtime/core/model-runtime.js";

// ---------------------------------------------------------------------------
// Whisper.cpp CLI adapter — wraps the binary as a ModelRuntime
// ---------------------------------------------------------------------------

const WHISPER_CLI =
  "/Users/seanb/Developer/Octomil/research/engines/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL =
  "/Users/seanb/Developer/Octomil/models/whisper-tiny/ggml-tiny.bin";

class WhisperCliRuntime implements ModelRuntime {
  private modelPath: string;

  constructor(modelPath: string) {
    this.modelPath = modelPath;
  }

  async createSession(): Promise<void> {
    // No-op — whisper-cli loads per invocation
  }

  async run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const audioData = input["mediaData"] as Uint8Array;
    if (!audioData) {
      throw new Error("No audio data provided");
    }

    // Write audio to temp file
    const tmpPath = path.join("/tmp", `octomil_whisper_${Date.now()}.wav`);
    fs.writeFileSync(tmpPath, audioData);

    try {
      const output = execSync(
        `"${WHISPER_CLI}" -m "${this.modelPath}" -f "${tmpPath}" --no-timestamps -nt 2>/dev/null`,
        { timeout: 30000 },
      ).toString().trim();

      return { text: output };
    } finally {
      fs.unlinkSync(tmpPath);
    }
  }

  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const canRun =
  fs.existsSync(WHISPER_CLI) && fs.existsSync(WHISPER_MODEL);

describe.skipIf(!canRun)(
  "Whisper.cpp audio transcription (integration)",
  () => {
    let speechWav: Uint8Array;

    beforeAll(() => {
      // Generate speech WAV using macOS say
      const wavPath = "/tmp/octomil_test_speech.wav";
      execSync(
        `say "Hello, this is a test of the Octomil transcription system." -o "${wavPath}" --data-format=LEI16@16000`,
      );
      speechWav = fs.readFileSync(wavPath);
    });

    it("transcribes speech via LocalFileModelRuntime + AudioTranscriptions", async () => {
      // 1. Create runtime (simulates what ModelCatalogService does for BUNDLED models)
      const whisperRuntime = new WhisperCliRuntime(WHISPER_MODEL);
      const localRuntime = new LocalFileModelRuntime(
        "whisper-tiny",
        WHISPER_MODEL,
      );
      localRuntime.setDelegate(whisperRuntime);

      // 2. Create AudioTranscriptions with a resolver that returns our runtime
      const transcriptions = new AudioTranscriptions((ref) => {
        return localRuntime;
      });

      // 3. Transcribe
      const result = await transcriptions.create({
        audio: speechWav,
      });

      console.log("Transcription result:", result.text);

      // 4. Assert
      expect(result.text).toBeTruthy();
      expect(result.text.toLowerCase()).toContain("test");
      // Whisper tiny may not get every word right, but should get the gist
      expect(
        result.text.toLowerCase().includes("hello") ||
          result.text.toLowerCase().includes("transcription") ||
          result.text.toLowerCase().includes("octomil") ||
          result.text.toLowerCase().includes("system"),
      ).toBe(true);
    });

    it("transcribes via stream() and yields segments", async () => {
      const whisperRuntime = new WhisperCliRuntime(WHISPER_MODEL);
      const localRuntime = new LocalFileModelRuntime(
        "whisper-tiny",
        WHISPER_MODEL,
      );
      localRuntime.setDelegate(whisperRuntime);

      const transcriptions = new AudioTranscriptions((ref) => localRuntime);

      const segments: { text: string }[] = [];
      for await (const segment of transcriptions.stream({ audio: speechWav })) {
        segments.push(segment);
      }

      expect(segments.length).toBeGreaterThan(0);
      expect(segments[0].text).toBeTruthy();
      console.log("Stream segment:", segments[0].text);
    });

    it("uses ModelRef.capability for transcription routing", async () => {
      const whisperRuntime = new WhisperCliRuntime(WHISPER_MODEL);
      const localRuntime = new LocalFileModelRuntime(
        "whisper-tiny",
        WHISPER_MODEL,
      );
      localRuntime.setDelegate(whisperRuntime);

      // Resolver routes transcription capability to whisper
      const transcriptions = new AudioTranscriptions((ref) => {
        if (ref.type === "capability" && ref.capability === ModelCapability.Transcription) {
          return localRuntime;
        }
        return undefined;
      });

      const result = await transcriptions.create({
        model: ModelRef.capability(ModelCapability.Transcription),
        audio: speechWav,
      });

      expect(result.text).toBeTruthy();
      console.log("Capability-routed transcription:", result.text);
    });
  },
);
