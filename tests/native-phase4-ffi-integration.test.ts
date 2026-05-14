/**
 * Phase 4 FFI integration tests — backends through real C ABI stub.
 *
 * These tests exercise the 4 Phase 3 native backends (VAD, speaker embedding,
 * diarization, TTS-stream) through the actual koffi FFI layer, using a
 * compiled C stub dylib built by buildNativeRuntimeStub.
 *
 * Unlike the existing Phase 3 backend tests (which mock NativeRuntime/
 * NativeSession in JS), these tests drive the full path:
 *
 *   NativeDiarizationBackend
 *     → NativeRuntime.open({ libraryPath })   [koffi loads .dylib/.so]
 *     → runtime.openSession(...)              [oct_session_open FFI call]
 *     → session.sendAudio(...)                [oct_session_send_audio FFI call]
 *     → session.pollEvent(...)                [oct_session_poll_event FFI call]
 *     → session.close()                       [oct_session_close FFI call]
 *     → runtime.close()                       [oct_runtime_close FFI call]
 *
 * Memory ownership contract verified here:
 *   - C strings (speakerLabel, requestId, etc.) are copied to JS strings inside
 *     pollEvent before the next FFI call invalidates them.
 *   - PCM byte buffers (tts_audio_chunk.pcm) are copied to Uint8Array / Float32Array
 *     inside pollEvent so the JS object outlives the next poll.
 *   - Embedding float arrays (embedding_vector.values) are decoded and copied
 *     into a JS number[] via decodeFloatArrayValue before next poll.
 *
 * These tests skip gracefully when cc/clang/gcc is unavailable to compile the
 * stub. They run unconditionally in the standard CI environments (Linux/macOS)
 * where a C compiler is always present.
 *
 * RUNTIME_UNAVAILABLE is only reachable when the stub dylib is absent, not
 * because of stubbed method paths. These tests verify that invariant.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FacadeDiarization } from "../src/audio/diarization.js";
import { FacadeSpeakerEmbedding } from "../src/audio/speaker_embedding.js";
import { NativeTtsStream } from "../src/audio/audio-speech.js";
import { FacadeVad, type VadSegment } from "../src/audio/vad.js";
import { NativeDiarizationBackend } from "../src/runtime/native/diarization_backend.js";
import { NativeRuntime } from "../src/runtime/native/index.js";
import { NativeSpeakerEmbeddingBackend } from "../src/runtime/native/speaker_backend.js";
import { NativeTtsStreamBackend } from "../src/runtime/native/tts_stream_backend.js";
import { NativeVadBackend } from "../src/runtime/native/vad_backend.js";
import { OctomilError } from "../src/types.js";
import { buildNativeRuntimeStub } from "./helpers/native-runtime-stub.js";

// ── Stub compilation ──────────────────────────────────────────────────────

const STUB_CAPABILITIES = [
  "audio.vad",
  "audio.speaker.embedding",
  "audio.diarization",
  "audio.tts.stream",
  "audio.tts.batch",
  "chat.completion",
  "embeddings.text",
];

const STUB_LIBRARY_PATH = buildNativeRuntimeStub({
  abiMinor: 10,
  capabilities: STUB_CAPABILITIES,
  engines: ["llama_cpp", "silero_vad", "sherpa_onnx"],
  archs: ["darwin-arm64"],
});

// Skip the entire suite when the host has no C compiler (rare edge case).
const describeWhenStubAvailable = STUB_LIBRARY_PATH
  ? describe
  : describe.skip.bind(describe, "stub unavailable");

// Dummy model URI for the C stub — oct_model_open accepts any non-empty URI.
const STUB_MODEL_URI = "file:///stub/model.gguf";

// ── VAD — model-free session through real FFI ─────────────────────────────

describeWhenStubAvailable(
  "NativeVadBackend — FFI integration through C stub (Phase 4)",
  () => {
    let backend: NativeVadBackend;

    afterEach(() => {
      try {
        backend?.close();
      } catch {
        /* best-effort */
      }
    });

    it("RUNTIME_UNAVAILABLE only fires when dylib is actually absent, not due to stubbed methods", () => {
      // With a real stub library present, RUNTIME_UNAVAILABLE must NOT be thrown.
      // If it were, it would indicate the FFI path is short-circuited.
      backend = new NativeVadBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      try {
        expect(() => backend.open()).not.toThrow();
      } finally {
        delete process.env.OCTOMIL_RUNTIME_DYLIB;
      }
    });

    it("open → openSession → feedChunk → pollTransitions → close through real koffi FFI", () => {
      backend = new NativeVadBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      try {
        backend.open();
        const sess = backend.openSession(16000);

        // Feed a small PCM chunk — stub stub always succeeds.
        const pcm = new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
        sess.feedChunk(pcm, 16000);

        // Drain with drainUntilCompleted — the stub emits SESSION_STARTED,
        // OCT_VAD_TRANSITION (kind=1 = speech_start), SESSION_COMPLETED.
        const transitions = Array.from(
          sess.pollTransitions({ deadlineMs: 10_000, drainUntilCompleted: true }),
        );

        // Stub emits one VAD transition (kind=1 speech_start at 250ms, conf=0.9).
        expect(transitions.length).toBeGreaterThanOrEqual(1);
        expect(transitions[0].kind).toBe("speech_start");
        expect(transitions[0].timestampMs).toBe(250);
        expect(transitions[0].confidence).toBeCloseTo(0.9, 2);

        sess.close();
      } finally {
        delete process.env.OCTOMIL_RUNTIME_DYLIB;
      }
    });

    it("FacadeVad.detect() returns VadSegment[] from C stub through full koffi stack", () => {
      // VAD stub only emits one speech_start, no speech_end — so segments may be
      // empty. The contract is: no throw, FacadeVad returns an array.
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      try {
        const vad = new FacadeVad();
        try {
          const pcm = new Float32Array([0.1, -0.1, 0.2, -0.2]);
          const result = vad.detect(pcm, { sampleRateHz: 16000 });
          expect(Array.isArray(result)).toBe(true);
          // Each returned segment must have the required shape.
          for (const seg of result as VadSegment[]) {
            expect(typeof seg.startMs).toBe("number");
            expect(typeof seg.endMs).toBe("number");
            expect(typeof seg.confidence).toBe("number");
          }
        } finally {
          vad.close();
        }
      } finally {
        delete process.env.OCTOMIL_RUNTIME_DYLIB;
      }
    });

    it("fails with a bounded OctomilError when OCTOMIL_RUNTIME_DYLIB points at a non-existent path", () => {
      // The backend translates NativeRuntimeError into a bounded OctomilError.
      // When the dylib path is bad, the backend throws RUNTIME_UNAVAILABLE or
      // INFERENCE_FAILED (status null → default 7 → INFERENCE_FAILED in the
      // runtimeStatusToSdkError mapping). Either code is an honest, bounded
      // signal — it must NOT be an uncaught NativeRuntimeError leak.
      const saved = process.env.OCTOMIL_RUNTIME_DYLIB;
      process.env.OCTOMIL_RUNTIME_DYLIB = "/definitely/not/a/real/path.dylib";
      try {
        backend = new NativeVadBackend();
        expect(() => backend.open()).toThrow(OctomilError);
        try {
          backend.open();
        } catch (err) {
          if (err instanceof OctomilError) {
            // Both codes are valid bounded errors for a missing dylib.
            expect(["RUNTIME_UNAVAILABLE", "INFERENCE_FAILED"]).toContain(err.code);
          }
        }
      } finally {
        if (saved !== undefined) {
          process.env.OCTOMIL_RUNTIME_DYLIB = saved;
        } else {
          delete process.env.OCTOMIL_RUNTIME_DYLIB;
        }
      }
    });
  },
);

// ── Diarization — model-free session through real FFI ─────────────────────

describeWhenStubAvailable(
  "NativeDiarizationBackend — FFI integration through C stub (Phase 4)",
  () => {
    let backend: NativeDiarizationBackend;

    afterEach(() => {
      try {
        backend?.close();
      } catch {
        /* best-effort */
      }
    });

    it("open → diarize → segments through real koffi FFI (model-free session)", () => {
      backend = new NativeDiarizationBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      try {
        backend.open();

        const audio = new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.4]);
        const segments = backend.diarize(audio, { sampleRateHz: 16000 });

        // Stub emits one DIARIZATION_SEGMENT: start=0, end=1100, speakerId=7,
        // speakerLabel="SPEAKER_00". Memory-ownership: speakerLabel is a C static
        // string that must be copied to a JS string inside pollEvent before the
        // next poll call invalidates it.
        expect(Array.isArray(segments)).toBe(true);
        expect(segments.length).toBeGreaterThanOrEqual(1);

        const first = segments[0];
        expect(first.startMs).toBe(0);
        expect(first.endMs).toBe(1100);
        expect(first.speakerId).toBe(7);
        // speakerLabel must survive as a JS string after session close.
        expect(first.speakerLabel).toBe("SPEAKER_00");
        expect(first.speakerIsUnknown).toBe(false);
      } finally {
        delete process.env.OCTOMIL_RUNTIME_DYLIB;
      }
    });

    it("FacadeDiarization.diarize() runs through real C ABI without RUNTIME_UNAVAILABLE", () => {
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      try {
        const facade = new FacadeDiarization();
        try {
          const audio = new Float32Array([0.1, -0.1, 0.2, -0.2]);
          const segments = facade.diarize(audio, { sampleRateHz: 16000 });
          expect(Array.isArray(segments)).toBe(true);
          // String fields must be copied JS values (not dangling C pointers).
          for (const seg of segments) {
            expect(typeof seg.speakerLabel).toBe("string");
            expect(typeof seg.speakerIsUnknown).toBe("boolean");
          }
        } finally {
          facade.close();
        }
      } finally {
        delete process.env.OCTOMIL_RUNTIME_DYLIB;
      }
    });

    it("diarize() runs model-free (no NativeModel handle required by audio.diarization)", () => {
      // The model field is NOT passed to openSession for audio.diarization.
      // This test verifies the C stub accepts a null model pointer for this
      // capability (model-free path). If the stub rejected null model, this
      // would throw rather than return segments.
      backend = new NativeDiarizationBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      try {
        // Directly verify via NativeRuntime that audio.diarization opens without model.
        const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
        try {
          const session = runtime.openSession({
            capability: "audio.diarization",
            // model deliberately omitted — must work model-free.
          });
          try {
            session.sendAudio(new Float32Array([0.1, -0.1]), 16_000, 1);
            const ev1 = session.pollEvent(0);
            expect(ev1.type).toBe(1); // SESSION_STARTED
            const ev2 = session.pollEvent(0);
            expect(ev2.type).toBe(25); // DIARIZATION_SEGMENT
            // speakerLabel must be a JS string (C pointer copied on decode).
            expect(ev2.diarizationSegment?.speakerLabel).toBe("SPEAKER_00");
          } finally {
            session.close();
          }
        } finally {
          runtime.close();
        }
      } finally {
        delete process.env.OCTOMIL_RUNTIME_DYLIB;
      }
    });
  },
);

// ── Speaker Embedding — model session through real FFI ────────────────────

describeWhenStubAvailable(
  "NativeSpeakerEmbeddingBackend — FFI integration through C stub (Phase 4)",
  () => {
    let backend: NativeSpeakerEmbeddingBackend;
    const SAVED_SPEAKER_MODEL_ENV = "OCTOMIL_SHERPA_SPEAKER_MODEL";

    afterEach(() => {
      try {
        backend?.close();
      } catch {
        /* best-effort */
      }
      delete process.env.OCTOMIL_RUNTIME_DYLIB;
      delete process.env[SAVED_SPEAKER_MODEL_ENV];
    });

    beforeAll(() => {
      // Nothing to pre-load — env vars are set per test.
    });

    it("loadModel + embed through real koffi FFI: returns Float32Array embedding", () => {
      backend = new NativeSpeakerEmbeddingBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      // Point OCTOMIL_SHERPA_SPEAKER_MODEL at stub URI so oct_model_open receives
      // a non-empty model_uri (the C stub accepts any non-empty URI).
      process.env[SAVED_SPEAKER_MODEL_ENV] = STUB_MODEL_URI;

      backend.loadModel("sherpa-eres2netv2-base");

      const audio = new Float32Array([0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
      const result = backend.embed(audio, { sampleRateHz: 16000 });

      // Stub emits EMBEDDING_VECTOR with values=[0.25, 0.75], n_dim=2.
      // Memory-ownership: float values are decoded via decodeFloatArrayValue
      // and copied into a JS number[] before the next poll call.
      expect(result.nDim).toBe(2);
      expect(result.isNormalized).toBe(true);
      expect(result.values).toBeInstanceOf(Float32Array);
      expect(result.values.length).toBe(2);
      expect(result.values[0]).toBeCloseTo(0.25, 3);
      expect(result.values[1]).toBeCloseTo(0.75, 3);
    });

    it("FacadeSpeakerEmbedding.embed() runs through C ABI without RUNTIME_UNAVAILABLE", () => {
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      process.env[SAVED_SPEAKER_MODEL_ENV] = STUB_MODEL_URI;

      const facade = new FacadeSpeakerEmbedding();
      try {
        const audio = new Float32Array([0.1, -0.1, 0.2, -0.2]);
        const result = facade.embed(audio, { sampleRateHz: 16000 });
        expect(result.values).toBeInstanceOf(Float32Array);
        expect(result.nDim).toBeGreaterThan(0);
        expect(result.values.length).toBe(result.nDim);
        // isNormalized must be a boolean, not a number (koffi uint8_t → boolean).
        expect(typeof result.isNormalized).toBe("boolean");
      } finally {
        facade.close();
      }
    });

    it("embed() float values survive across multiple pollEvent calls (memory ownership)", () => {
      // Verifies that embeddingVector.values is a JS-owned copy, not a reference to
      // C-side memory that is invalidated by the subsequent pollEvent (SESSION_COMPLETED).
      backend = new NativeSpeakerEmbeddingBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      process.env[SAVED_SPEAKER_MODEL_ENV] = STUB_MODEL_URI;

      backend.loadModel();

      const audio = new Float32Array([0.1, 0.2]);
      const result = backend.embed(audio);

      // Capture values before any further runtime interaction.
      const capturedValues = Array.from(result.values);

      // Any subsequent call would invalidate C-side event memory if the SDK
      // had not copied. Verify the captured values are unchanged.
      expect(capturedValues.length).toBe(result.nDim);
      expect(capturedValues[0]).toBeCloseTo(0.25, 3);
    });
  },
);

// ── TTS Stream — model session through real FFI ───────────────────────────

describeWhenStubAvailable(
  "NativeTtsStreamBackend — FFI integration through C stub (Phase 4)",
  () => {
    let backend: NativeTtsStreamBackend;
    const TTS_MODEL_ENV = "OCTOMIL_SHERPA_TTS_MODEL";

    afterEach(() => {
      try {
        backend?.close();
      } catch {
        /* best-effort */
      }
      delete process.env.OCTOMIL_RUNTIME_DYLIB;
      delete process.env[TTS_MODEL_ENV];
    });

    it("loadModel + synthesizeWithChunks: yields TtsAudioChunk with PCM data through real FFI", () => {
      backend = new NativeTtsStreamBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      // C stub accepts any non-empty model_uri.
      process.env[TTS_MODEL_ENV] = STUB_MODEL_URI;

      backend.loadModel("sherpa-vits-base");

      const chunks = Array.from(
        backend.synthesizeWithChunks("Hello world", { voiceId: "0" }),
      );

      // Stub emits TTS_AUDIO_CHUNK with pcm=[1,2,3,4], sample_rate=24000,
      // sample_format=2 (PCM_F32LE), channels=1, is_final=1.
      // Memory-ownership: tts_audio_chunk.pcm (uint8_t*) is copied to Uint8Array
      // inside pollEvent. The Float32Array view built from it in the backend is
      // then copied again via pcmF32.slice(), so it outlives session close.
      expect(chunks.length).toBeGreaterThanOrEqual(1);

      const last = chunks[chunks.length - 1];
      expect(last.isFinal).toBe(true);
      expect(last.sampleRateHz).toBe(24000);
      expect(last.streamingMode).toBe("progressive");
      expect(last.pcmF32).toBeInstanceOf(Float32Array);
      // Stub sets sample_format=2 (PCM_F32LE), channels=1.
      expect(last.pcmF32.length).toBeGreaterThan(0);
    });

    it("NativeTtsStream.stream() yields chunks through C ABI without RUNTIME_UNAVAILABLE", () => {
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      process.env[TTS_MODEL_ENV] = STUB_MODEL_URI;

      const stream = new NativeTtsStream();
      try {
        const chunks = Array.from(
          stream.stream({ model: "sherpa-vits-base", input: "Hi" }),
        );
        expect(Array.isArray(chunks)).toBe(true);
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        for (const chunk of chunks) {
          expect(chunk.pcmF32).toBeInstanceOf(Float32Array);
          expect(typeof chunk.sampleRateHz).toBe("number");
          expect(typeof chunk.isFinal).toBe("boolean");
        }
      } finally {
        stream.close();
      }
    });

    it("pcmF32 data survives session.close() (copy-on-decode memory contract)", () => {
      // Verifies the PCM bytes are JS-owned after pollEvent, not dangling C pointers.
      backend = new NativeTtsStreamBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      process.env[TTS_MODEL_ENV] = STUB_MODEL_URI;

      backend.loadModel("sherpa-vits-base");

      const chunks = Array.from(
        backend.synthesizeWithChunks("test"),
      );

      // session.close() is called inside _drain's finally block. Capture the
      // PCM float data after that point and verify it still reads correctly.
      expect(chunks.length).toBeGreaterThan(0);
      const firstChunk = chunks[0];

      // If the Float32Array were a view over C-side memory freed on session close,
      // reading it here would return garbage or throw. We expect stable values.
      const capturedSample = firstChunk.pcmF32[0];
      expect(typeof capturedSample).toBe("number");
      expect(Number.isFinite(capturedSample)).toBe(true);
    });

    it("loadModel is idempotent when called with the same model name", () => {
      backend = new NativeTtsStreamBackend();
      process.env.OCTOMIL_RUNTIME_DYLIB = STUB_LIBRARY_PATH!;
      process.env[TTS_MODEL_ENV] = STUB_MODEL_URI;

      backend.loadModel("sherpa-vits-base");
      // Second call with same model — must not throw or re-open runtime.
      expect(() => backend.loadModel("sherpa-vits-base")).not.toThrow();
    });
  },
);

// ── Cross-backend: model-free vs model-required contract ──────────────────

describeWhenStubAvailable(
  "Phase 4 FFI — model-free vs model-required session contract",
  () => {
    afterEach(() => {
      delete process.env.OCTOMIL_RUNTIME_DYLIB;
    });

    it("audio.vad opens without a model handle (model-free)", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const session = runtime.openSession({
          capability: "audio.vad",
          // No model field — model-free path.
        });
        session.close();
      } finally {
        runtime.close();
      }
    });

    it("audio.diarization opens without a model handle (model-free)", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const session = runtime.openSession({
          capability: "audio.diarization",
          // No model field — model-free path.
        });
        session.close();
      } finally {
        runtime.close();
      }
    });

    it("audio.speaker.embedding opens with a model handle (model required)", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const model = runtime.openModel({ modelUri: STUB_MODEL_URI });
        model.warm();
        const session = runtime.openSession({
          capability: "audio.speaker.embedding",
          model,
        });
        session.close();
        model.close();
      } finally {
        runtime.close();
      }
    });

    it("audio.tts.stream opens with a model handle (model required)", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const model = runtime.openModel({ modelUri: STUB_MODEL_URI });
        model.warm();
        const session = runtime.openSession({
          capability: "audio.tts.stream",
          model,
        });
        // Send text synchronously before polling, mirroring the backend contract.
        session.sendText("Hello");
        session.close();
        model.close();
      } finally {
        runtime.close();
      }
    });
  },
);

// ── pollEvent string/bytes copy-after-next-poll invariant ─────────────────

describeWhenStubAvailable(
  "Phase 4 FFI — event payload memory ownership (copy-on-decode)",
  () => {
    it("diarizationSegment.speakerLabel is a JS-owned string after pollEvent", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const session = runtime.openSession({ capability: "audio.diarization" });
        try {
          session.sendAudio(new Float32Array([0.1, -0.1, 0.2]), 16_000, 1);

          const started = session.pollEvent(0);
          expect(started.type).toBe(1); // SESSION_STARTED
          // started.requestId must be a JS string, not a C-string pointer.
          expect(typeof started.requestId).toBe("string");

          const segEvent = session.pollEvent(0);
          expect(segEvent.type).toBe(25); // DIARIZATION_SEGMENT
          const label = segEvent.diarizationSegment?.speakerLabel;

          // Poll again — if label were a dangling C pointer, it would now be
          // invalidated by the next pollEvent call.
          const completedEvent = session.pollEvent(0);
          expect(completedEvent.type).toBe(8); // SESSION_COMPLETED

          // label must still be the correct string.
          expect(label).toBe("SPEAKER_00");
          expect(typeof label).toBe("string");
        } finally {
          session.close();
        }
      } finally {
        runtime.close();
      }
    });

    it("ttsAudioChunk.pcm is a JS-owned Uint8Array after pollEvent", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const model = runtime.openModel({ modelUri: STUB_MODEL_URI });
        model.warm();
        const session = runtime.openSession({
          capability: "audio.tts.stream",
          model,
        });
        try {
          session.sendText("hi");

          const started = session.pollEvent(0);
          expect(started.type).toBe(1);

          const chunkEvent = session.pollEvent(0);
          expect(chunkEvent.type).toBe(23); // TTS_AUDIO_CHUNK
          const pcm = chunkEvent.ttsAudioChunk?.pcm;

          // Poll again — if pcm were a view over C memory, next poll invalidates it.
          const completedEvent = session.pollEvent(0);
          expect(completedEvent.type).toBe(8);

          // pcm must still contain the stub's byte values [1, 2, 3, 4].
          expect(pcm).toBeInstanceOf(Uint8Array);
          expect(pcm!.length).toBe(4);
          expect(pcm![0]).toBe(1);
          expect(pcm![1]).toBe(2);
          expect(pcm![2]).toBe(3);
          expect(pcm![3]).toBe(4);
        } finally {
          session.close();
        }
        model.close();
      } finally {
        runtime.close();
      }
    });

    it("embeddingVector.values is a JS-owned number[] after pollEvent", () => {
      const runtime = NativeRuntime.open({ libraryPath: STUB_LIBRARY_PATH! });
      try {
        const model = runtime.openModel({ modelUri: STUB_MODEL_URI });
        model.warm();
        const session = runtime.openSession({
          capability: "audio.speaker.embedding",
          model,
        });
        try {
          session.sendAudio(new Float32Array([0.1, -0.1]), 16_000, 1);

          const started = session.pollEvent(0);
          expect(started.type).toBe(1);

          const embeddingEvent = session.pollEvent(0);
          expect(embeddingEvent.type).toBe(20); // EMBEDDING_VECTOR
          const values = embeddingEvent.embeddingVector?.values;

          // Poll again to advance event buffer state.
          const completedEvent = session.pollEvent(0);
          expect(completedEvent.type).toBe(8);

          // Values must be a JS-owned array with the stub's [0.25, 0.75] data.
          expect(Array.isArray(values)).toBe(true);
          expect(values!.length).toBe(2);
          expect(values![0]).toBeCloseTo(0.25, 3);
          expect(values![1]).toBeCloseTo(0.75, 3);
        } finally {
          session.close();
        }
        model.close();
      } finally {
        runtime.close();
      }
    });
  },
);
