import { describe, it, expect, vi } from "vitest";
import { AudioTranscriptions } from "../src/audio/audio-transcriptions.js";
import { ModelRef } from "../src/model-ref.js";
import { ModelCapability } from "../src/_generated/model_capability.js";
import type { ModelRuntime } from "../src/runtime/core/model-runtime.js";
import { OctomilError } from "../src/types.js";

function mockRuntime(text = "hello world"): ModelRuntime {
  return {
    createSession: vi.fn(),
    run: vi.fn().mockResolvedValue({ text }),
    dispose: vi.fn(),
  };
}

describe("AudioTranscriptions", () => {
  describe("create", () => {
    it("should transcribe audio using default transcription model", async () => {
      const runtime = mockRuntime("transcribed text");
      const resolver = vi.fn().mockReturnValue(runtime);
      const at = new AudioTranscriptions(resolver);

      const result = await at.create({ audio: new Uint8Array([1, 2, 3]) });

      expect(result.text).toBe("transcribed text");
      expect(resolver).toHaveBeenCalledWith(
        ModelRef.capability(ModelCapability.Transcription),
      );
    });

    it("should pass language to runtime", async () => {
      const runtime = mockRuntime("bonjour");
      const resolver = vi.fn().mockReturnValue(runtime);
      const at = new AudioTranscriptions(resolver);

      await at.create({
        audio: new Uint8Array([1, 2, 3]),
        language: "fr",
      });

      expect(runtime.run).toHaveBeenCalledWith({
        prompt: "fr",
        mediaData: expect.any(Uint8Array),
        mediaType: "audio",
      });
    });

    it("should use custom model ref", async () => {
      const runtime = mockRuntime("custom output");
      const resolver = vi.fn().mockReturnValue(runtime);
      const at = new AudioTranscriptions(resolver);

      const ref = ModelRef.id("whisper-large");
      await at.create({ audio: new Uint8Array([1, 2, 3]), model: ref });

      expect(resolver).toHaveBeenCalledWith(ref);
    });

    it("should throw when no runtime available", async () => {
      const resolver = vi.fn().mockReturnValue(undefined);
      const at = new AudioTranscriptions(resolver);

      await expect(
        at.create({ audio: new Uint8Array([1, 2, 3]) }),
      ).rejects.toThrow(OctomilError);
    });

    it("should include language in result", async () => {
      const runtime = mockRuntime("hello");
      const resolver = vi.fn().mockReturnValue(runtime);
      const at = new AudioTranscriptions(resolver);

      const result = await at.create({
        audio: new Uint8Array([1, 2, 3]),
        language: "en",
      });

      expect(result.language).toBe("en");
      expect(result.segments).toEqual([]);
    });
  });

  describe("stream", () => {
    it("should yield segments from runtime", async () => {
      const runtime = mockRuntime("streamed text");
      const resolver = vi.fn().mockReturnValue(runtime);
      const at = new AudioTranscriptions(resolver);

      const segments: Array<{ text: string }> = [];
      for await (const segment of at.stream({ audio: new Uint8Array([1, 2, 3]) })) {
        segments.push(segment);
      }

      expect(segments).toHaveLength(1);
      expect(segments[0]!.text).toBe("streamed text");
    });

    it("should throw when no runtime available", async () => {
      const resolver = vi.fn().mockReturnValue(undefined);
      const at = new AudioTranscriptions(resolver);

      await expect(async () => {
        for await (const _seg of at.stream({ audio: new Uint8Array([1, 2, 3]) })) {
          // consume
        }
      }).rejects.toThrow(OctomilError);
    });

    it("should yield nothing for empty text", async () => {
      const runtime = mockRuntime("");
      const resolver = vi.fn().mockReturnValue(runtime);
      const at = new AudioTranscriptions(resolver);

      const segments: Array<{ text: string }> = [];
      for await (const segment of at.stream({ audio: new Uint8Array([1, 2, 3]) })) {
        segments.push(segment);
      }

      expect(segments).toHaveLength(0);
    });
  });
});
