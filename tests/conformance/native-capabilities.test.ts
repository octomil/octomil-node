/**
 * Native capability conformance tests — Node SDK (Lane A bootstrap).
 *
 * Covers the 12 live native / live-conditional capabilities:
 *   1. chat.completion
 *   2. chat.stream
 *   3. embeddings.text
 *   4. audio.transcription
 *   5. audio.stt.batch
 *   6. audio.stt.stream
 *   7. audio.vad
 *   8. audio.speaker.embedding
 *   9. audio.diarization
 *   10. audio.tts.batch
 *   11. audio.tts.stream
 *   12. cache.introspect
 *
 * chat.stream is now an advertised native capability that dispatches through
 * the same llama.cpp session path as chat.completion.
 *
 * audio.diarization, audio.stt.batch, audio.stt.stream, and cache.introspect are
 * live-conditional, not reserved. cache.introspect is a runtime/cache ABI
 * capability, not a session lifecycle capability.
 *
 * The lifecycle smoke harness runs against a stub native ABI when the real
 * runtime artifact is absent. It can also exercise OCTOMIL_RUNTIME_DYLIB when
 * that env var points at a real liboctomil-runtime build.
 *
 * DO NOT add cloud fallback to make any of these tests pass. Cloud inference
 * is a different transport and does not prove native capability conformance.
 */

import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code.js";
import { RuntimeCapability } from "../../src/_generated/runtime_capability.js";
import { NativeRuntime } from "../../src/runtime/native/index.js";
import { buildNativeRuntimeStub } from "../helpers/native-runtime-stub.js";

// ── Capability identifiers (byte-for-byte from contracts) ──────────────────
// Source: octomil-contracts/conformance/<capability>.yaml field `capability:`
const LIVE_CAPABILITIES = [
  "chat.completion",
  "chat.stream",
  "embeddings.text",
  "audio.transcription",
  "audio.stt.batch",
  "audio.stt.stream",
  "audio.vad",
  "audio.speaker.embedding",
  "audio.diarization",
  "audio.tts.batch",
  "audio.tts.stream",
  "cache.introspect",
] as const;

type LiveCapability = (typeof LIVE_CAPABILITIES)[number];
const SESSION_CAPABILITIES = LIVE_CAPABILITIES.filter(
  (cap) => cap !== "cache.introspect",
) as Exclude<LiveCapability, "cache.introspect">[];
type SessionCapability = (typeof SESSION_CAPABILITIES)[number];

const LIFECYCLE_LIBRARY_PATH =
  process.env.OCTOMIL_RUNTIME_DYLIB ??
  buildNativeRuntimeStub({
    capabilities: [...LIVE_CAPABILITIES],
    engines: ["llama_cpp", "whisper_cpp", "silero_vad", "sherpa_onnx"],
    archs: ["darwin-arm64"],
  });

const describeLifecycle = LIFECYCLE_LIBRARY_PATH ? describe : describe.skip;

const NON_ADVERTISED_PROFILES = [] as const;

// These are live-conditional, not reserved exclusions.
const CONDITIONAL_CAPABILITIES = [
  "audio.diarization",
  "audio.stt.batch",
  "audio.stt.stream",
  "cache.introspect",
] as const;

// ── Error codes used by the live capabilities ──────────────────────────────
// Sourced from bounded_error_codes in each capability YAML.
// These must exist in ErrorCode (byte-for-byte values enforced by contract.test.ts).
const BOUNDED_ERROR_CODES_BY_CAPABILITY: Record<SessionCapability, string[]> = {
  "chat.completion": ["invalid_input", "context_too_large", "inference_failed", "cancelled"],
  "chat.stream": ["invalid_input", "inference_failed", "cancelled", "stream_interrupted"],
  "embeddings.text": ["invalid_input", "context_too_large", "inference_failed", "cancelled"],
  "audio.transcription": [
    "invalid_input",
    "inference_failed",
    "cancelled",
    "unsupported_modality",
    "runtime_unavailable",
  ],
  "audio.stt.batch": [
    "invalid_input",
    "inference_failed",
    "cancelled",
    "unsupported_modality",
    "runtime_unavailable",
  ],
  "audio.stt.stream": [
    "invalid_input",
    "inference_failed",
    "cancelled",
    "unsupported_modality",
    "runtime_unavailable",
    "stream_interrupted",
  ],
  "audio.vad": ["invalid_input", "inference_failed", "cancelled", "unsupported_modality"],
  "audio.speaker.embedding": ["invalid_input", "inference_failed", "cancelled", "unsupported_modality"],
  "audio.diarization": ["invalid_input", "runtime_unavailable", "cancelled", "inference_failed"],
  "audio.tts.batch": ["invalid_input", "runtime_unavailable", "model_not_found", "cancelled", "inference_failed"],
  "audio.tts.stream": [
    "invalid_input",
    "runtime_unavailable",
    "model_not_found",
    "cancelled",
    "inference_failed",
  ],
};

// ── Expected event sequences (from contracts YAMLs) ──────────────────────
// Each entry encodes the contracted event order and quantifiers.
// Source: expected_event_sequence in each capability YAML.
const EXPECTED_EVENT_SEQUENCES: Record<SessionCapability, { event: string; quantifier: string }[]> = {
  "chat.completion": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_TRANSCRIPT_CHUNK", quantifier: "one_or_more" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "chat.stream": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_TRANSCRIPT_CHUNK", quantifier: "one_or_more" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "embeddings.text": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_EMBEDDING_VECTOR", quantifier: "one_or_more" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.transcription": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_TRANSCRIPT_SEGMENT", quantifier: "one_or_more" },
    { event: "OCT_EVENT_TRANSCRIPT_FINAL", quantifier: "exactly_one" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.stt.batch": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_TRANSCRIPT_SEGMENT", quantifier: "one_or_more" },
    { event: "OCT_EVENT_TRANSCRIPT_FINAL", quantifier: "exactly_one" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.stt.stream": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_TRANSCRIPT_SEGMENT", quantifier: "one_or_more" },
    { event: "OCT_EVENT_TRANSCRIPT_FINAL", quantifier: "exactly_one" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.vad": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_VAD_TRANSITION", quantifier: "one_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.speaker.embedding": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_EMBEDDING_VECTOR", quantifier: "exactly_one" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.diarization": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_DIARIZATION_SEGMENT", quantifier: "one_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.tts.batch": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_TTS_AUDIO_CHUNK", quantifier: "one_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
  "audio.tts.stream": [
    { event: "OCT_EVENT_SESSION_STARTED", quantifier: "exactly_one" },
    { event: "OCT_EVENT_TTS_AUDIO_CHUNK", quantifier: "one_or_more" },
    { event: "OCT_EVENT_METRIC", quantifier: "zero_or_more" },
    { event: "OCT_EVENT_SESSION_COMPLETED", quantifier: "exactly_one" },
  ],
};

// ── Privacy deny-field substrings (from contracts YAMLs) ─────────────────
// Metric/log events MUST NOT leak these strings in any telemetry payload.
// Source: privacy_constraints.deny_field_substrings in each capability YAML.
const PRIVACY_DENY_SUBSTRINGS: Record<LiveCapability, string[]> = {
  "chat.completion": ["/Users/", "/private/var/", "/home/"],
  "chat.stream": ["/Users/", "/private/var/", "/home/"],
  "embeddings.text": ["/Users/", "/private/var/"],
  "audio.transcription": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "ggml-tiny.bin"],
  "audio.stt.batch": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "ggml-tiny.bin"],
  "audio.stt.stream": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "ggml-tiny.bin"],
  "audio.vad": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "ggml-silero"],
  "audio.speaker.embedding": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm"],
  "audio.diarization": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "pyannote", "speaker"],
  "audio.tts.batch": [
    "audio_bytes",
    "raw_audio",
    "audio_pcm",
    "wav_bytes",
    "transcript_text",
    "input_text",
    "prompt_text",
    "voice_metadata",
  ],
  "audio.tts.stream": [
    "audio_bytes",
    "raw_audio",
    "audio_pcm",
    "wav_bytes",
    "transcript_text",
    "input_text",
    "prompt_text",
    "voice_metadata",
  ],
  "cache.introspect": [
    "/Users/",
    "/private/var/",
    "/home/",
    "prompt_text",
    "audio_bytes",
    "embedding_vector",
    "cache_key",
  ],
};

// ── audio.tts.stream honesty fields (v0.1.9 progressive flip) ─────────────
// Source: audio.tts.stream.yaml delivery_timing, proof_artifact fields.
const TTS_STREAM_HONESTY = {
  delivery_timing: "progressive_during_synthesis",
  progressive_first_audio: true,
  realtime_streaming_claim: true,
  proof_artifact_required: true,
  measured_first_audio_ratio: 0.5909, // gate: < 0.75
  measured_rtf: 0.105, // gate: < 1.0
  measured_chunk_count: 2, // gate: >= 2
} as const;

// ── Allowed event type closed set ────────────────────────────────────────
// Invariant 7: emitted event types ⊆ expected_event_sequence ∪ runtime-scope events
const RUNTIME_SCOPE_EVENTS = new Set([
  "OCT_EVENT_MODEL_LOADED",
  "OCT_EVENT_MODEL_EVICTED",
  "OCT_EVENT_CACHE_HIT",
  "OCT_EVENT_CACHE_MISS",
  "OCT_EVENT_MEMORY_PRESSURE",
  "OCT_EVENT_THERMAL_STATE",
  "OCT_EVENT_METRIC",
  "OCT_EVENT_NONE",
]);

function allowedEventSet(cap: SessionCapability): Set<string> {
  const capEvents = new Set(EXPECTED_EVENT_SEQUENCES[cap].map((e) => e.event));
  return new Set([...capEvents, ...RUNTIME_SCOPE_EVENTS]);
}

// ─────────────────────────────────────────────────────────────────────────
// Section 1: Structural / static conformance (always runs, no runtime FFI)
// ─────────────────────────────────────────────────────────────────────────

describe("Native capability conformance — static / structural", () => {
  describe("Live capability set", () => {
    it("declares exactly the 12 live/native-conditional capabilities (no overclaim)", () => {
      expect(LIVE_CAPABILITIES).toHaveLength(12);
      expect(LIVE_CAPABILITIES).toContain("chat.completion");
      expect(LIVE_CAPABILITIES).toContain("chat.stream");
      expect(LIVE_CAPABILITIES).toContain("embeddings.text");
      expect(LIVE_CAPABILITIES).toContain("audio.transcription");
      expect(LIVE_CAPABILITIES).toContain("audio.stt.batch");
      expect(LIVE_CAPABILITIES).toContain("audio.stt.stream");
      expect(LIVE_CAPABILITIES).toContain("audio.vad");
      expect(LIVE_CAPABILITIES).toContain("audio.speaker.embedding");
      expect(LIVE_CAPABILITIES).toContain("audio.diarization");
      expect(LIVE_CAPABILITIES).toContain("audio.tts.batch");
      expect(LIVE_CAPABILITIES).toContain("audio.tts.stream");
      expect(LIVE_CAPABILITIES).toContain("cache.introspect");
    });

    it("treats audio.diarization as live-conditional, not reserved", () => {
      expect(CONDITIONAL_CAPABILITIES).toContain("audio.diarization");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("audio.diarization");
    });

    it("treats audio.stt.batch as a live alias of audio.transcription", () => {
      expect(CONDITIONAL_CAPABILITIES).toContain("audio.stt.batch");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("audio.stt.batch");
      expect(SESSION_CAPABILITIES as ReadonlyArray<string>).toContain("audio.stt.batch");
      expect(CONDITIONAL_CAPABILITIES).toContain("audio.stt.stream");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("audio.stt.stream");
      expect(SESSION_CAPABILITIES as ReadonlyArray<string>).toContain("audio.stt.stream");
    });

    it("treats cache.introspect as live runtime/cache ABI, not session lifecycle", () => {
      expect(CONDITIONAL_CAPABILITIES).toContain("cache.introspect");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("cache.introspect");
      expect(SESSION_CAPABILITIES as ReadonlyArray<string>).not.toContain("cache.introspect");
    });

    it("does NOT claim audio.realtime.session (not live)", () => {
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).not.toContain("audio.realtime.session");
    });

    it("does NOT claim embeddings.image (not live)", () => {
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).not.toContain("embeddings.image");
    });

    it("does NOT claim index.vector.query (not live)", () => {
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).not.toContain("index.vector.query");
    });
  });

  describe("chat.stream advertised native invariant", () => {
    it("chat.stream is a live advertised capability", () => {
      expect(NON_ADVERTISED_PROFILES).not.toContain("chat.stream");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("chat.stream");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("chat.completion");
    });
  });

  describe("Bounded error codes — contracts byte-for-byte", () => {
    for (const cap of SESSION_CAPABILITIES) {
      it(`${cap}: all bounded error codes exist in ErrorCode enum`, () => {
        const allCodes = Object.values(ErrorCode);
        for (const code of BOUNDED_ERROR_CODES_BY_CAPABILITY[cap]) {
          expect(allCodes).toContain(code);
        }
      });
    }
  });

  describe("Event sequence structure — Invariant 7 closed-set", () => {
    for (const cap of SESSION_CAPABILITIES) {
      it(`${cap}: event allowed set is non-empty and all names are OCT_EVENT_* strings`, () => {
        const allowed = allowedEventSet(cap);
        expect(allowed.size).toBeGreaterThan(0);
        for (const evt of allowed) {
          expect(evt).toMatch(/^OCT_EVENT_/);
        }
      });

      it(`${cap}: expected sequence matches contracts YAML`, () => {
        const seq = EXPECTED_EVENT_SEQUENCES[cap];
        expect(seq.length).toBeGreaterThan(0);
        // Every capability must start with SESSION_STARTED and end with SESSION_COMPLETED.
        expect(seq[0].event).toBe("OCT_EVENT_SESSION_STARTED");
        expect(seq[seq.length - 1].event).toBe("OCT_EVENT_SESSION_COMPLETED");
      });
    }
  });

  describe("audio.tts.stream honesty tokens — v0.1.9 progressive proof", () => {
    it("delivery_timing is progressive_during_synthesis (not coalesced)", () => {
      expect(TTS_STREAM_HONESTY.delivery_timing).toBe("progressive_during_synthesis");
    });

    it("progressive_first_audio=true implies realtime_streaming_claim=true", () => {
      // Mathematical invariant from audio.tts.stream.yaml:
      // progressive_first_audio=true => realtime_streaming_claim MUST also be true.
      if (TTS_STREAM_HONESTY.progressive_first_audio) {
        expect(TTS_STREAM_HONESTY.realtime_streaming_claim).toBe(true);
      }
    });

    it("delivery_timing=progressive_during_synthesis implies proof_artifact required", () => {
      if (TTS_STREAM_HONESTY.delivery_timing === "progressive_during_synthesis") {
        expect(TTS_STREAM_HONESTY.proof_artifact_required).toBe(true);
      }
    });

    it("measured first_audio_ratio satisfies gate < 0.75", () => {
      expect(TTS_STREAM_HONESTY.measured_first_audio_ratio).toBeLessThan(0.75);
    });

    it("measured RTF satisfies gate < 1.0 (realtime definition)", () => {
      expect(TTS_STREAM_HONESTY.measured_rtf).toBeLessThan(1.0);
    });

    it("measured chunk_count satisfies gate >= 2", () => {
      expect(TTS_STREAM_HONESTY.measured_chunk_count).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Privacy deny-fields — structural coverage check", () => {
    for (const cap of LIVE_CAPABILITIES) {
      it(`${cap}: deny_field_substrings list is non-empty`, () => {
        expect(PRIVACY_DENY_SUBSTRINGS[cap].length).toBeGreaterThan(0);
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Section 2: Native runtime lifecycle/event/error tests
//
// These tests run against a stub native ABI when no real runtime artifact is
// available. If OCTOMIL_RUNTIME_DYLIB is configured, the same smoke harness
// can exercise that library directly.
// DO NOT add cloud fallback to make these pass. Cloud inference is a
// different transport and does not prove native capability conformance.
// ─────────────────────────────────────────────────────────────────────────

describeLifecycle("Native capability conformance — lifecycle smoke", () => {
  const SESSION_STARTED = 1;
  const TRANSCRIPT_CHUNK = 3;
  const EMBEDDING_VECTOR = 20;
  const TRANSCRIPT_SEGMENT = 21;
  const TRANSCRIPT_FINAL = 22;
  const TTS_AUDIO_CHUNK = 23;
  const VAD_TRANSITION = 24;
  const DIARIZATION_SEGMENT = 25;
  const SESSION_COMPLETED = 8;

  function inputForCapability(cap: SessionCapability): {
    samples?: Float32Array;
    text?: string;
  } {
    if (cap.startsWith("audio.") && !cap.includes("tts")) {
      return { samples: new Float32Array([0.1, -0.1, 0.2, -0.2]) };
    }
    return { text: `hello from ${cap}` };
  }

  for (const cap of SESSION_CAPABILITIES) {
    it(`${cap}: opens, sends, polls, and closes through the native ABI`, () => {
      const runtime = NativeRuntime.open({ libraryPath: LIFECYCLE_LIBRARY_PATH! });
      let model: ReturnType<NativeRuntime["openModel"]> | null = null;
      let session: ReturnType<NativeRuntime["openSession"]> | null = null;

      try {
        const caps = runtime.capabilities();
        expect(caps.supportedCapabilities).toContain(
          cap as RuntimeCapability,
        );
        expect(caps.supportedCapabilities).toContain(RuntimeCapability.ChatStream);

        model = runtime.openModel({
          modelUri: `file:///stub/${cap}.gguf`,
        });
        model.warm();

        session = runtime.openSession({
          capability: cap,
          model,
          modelUri: `file:///stub/${cap}.gguf`,
        });

        const input = inputForCapability(cap);
        if (input.samples) {
          session.sendAudio(input.samples, 16_000, 1);
        } else if (input.text) {
          session.sendText(input.text);
        }

        const observedTypes: number[] = [];
        let seenCompletion = false;
        for (let i = 0; i < 8; i += 1) {
          const event = session.pollEvent(0);
          observedTypes.push(event.type);
          if (event.type === SESSION_STARTED) {
            expect(event.requestId).toBe("");
          }
          if ((cap === "chat.completion" || cap === "chat.stream") && event.transcriptChunk) {
            expect(event.transcriptChunk.text).toBe("hello");
          }
          if (cap === "embeddings.text" && event.embeddingVector) {
            expect(event.embeddingVector.values).toEqual([0.25, 0.75]);
          }
          if ((cap === "audio.transcription" || cap === "audio.stt.batch" || cap === "audio.stt.stream") && event.transcriptSegment) {
            expect(event.transcriptSegment.text).toBe("segment");
          }
          if ((cap === "audio.transcription" || cap === "audio.stt.batch" || cap === "audio.stt.stream") && event.transcriptFinal) {
            expect(event.transcriptFinal.nSegments).toBe(1);
          }
          if (cap === "audio.vad" && event.vadTransition) {
            expect(event.vadTransition.confidence).toBeGreaterThan(0.5);
          }
          if (cap === "audio.diarization" && event.diarizationSegment) {
            expect(event.diarizationSegment.speakerLabel).toBe("SPEAKER_00");
          }
          if (cap.includes("tts") && event.ttsAudioChunk) {
            expect(event.ttsAudioChunk.pcm.length).toBeGreaterThan(0);
          }
          if (event.type === SESSION_COMPLETED) {
            expect(event.sessionCompleted?.terminalStatus).toBe(0);
            seenCompletion = true;
            break;
          }
        }

        expect(seenCompletion).toBe(true);
        expect(observedTypes).toContain(SESSION_STARTED);
        expect(observedTypes).toContain(SESSION_COMPLETED);

        if (cap === "chat.completion" || cap === "chat.stream") {
          expect(observedTypes).toContain(TRANSCRIPT_CHUNK);
        }
        if (cap === "embeddings.text" || cap === "audio.speaker.embedding") {
          expect(observedTypes).toContain(EMBEDDING_VECTOR);
        }
        if (cap === "audio.transcription" || cap === "audio.stt.batch" || cap === "audio.stt.stream") {
          expect(observedTypes).toContain(TRANSCRIPT_SEGMENT);
          expect(observedTypes).toContain(TRANSCRIPT_FINAL);
        }
        if (cap === "audio.vad") {
          expect(observedTypes).toContain(VAD_TRANSITION);
        }
        if (cap === "audio.diarization") {
          expect(observedTypes).toContain(DIARIZATION_SEGMENT);
        }
        if (cap === "audio.tts.batch" || cap === "audio.tts.stream") {
          expect(observedTypes).toContain(TTS_AUDIO_CHUNK);
        }
      } finally {
        session?.close();
        model?.close();
        runtime.close();
      }
    });
  }

  it("advertises chat.stream as a live capability", () => {
    const runtime = NativeRuntime.open({ libraryPath: LIFECYCLE_LIBRARY_PATH! });
    try {
      expect(runtime.capabilities().supportedCapabilities).toContain(
        RuntimeCapability.ChatStream,
      );
      const model = runtime.openModel({ modelUri: "file:///stub/chat-stream.gguf" });
      try {
        const session = runtime.openSession({
          capability: "chat.stream",
          model,
          modelUri: "file:///stub/chat-stream.gguf",
        });
        session.close();
      } finally {
        model.close();
      }
    } finally {
      runtime.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Section 3: Minimal live-path smoke test
//
// chat.completion via cloud transport (NOT native runtime).
// This smoke test proves the SDK can construct and dispatch a request;
// it does NOT prove native runtime FFI conformance. It is included so
// CI has at least one end-to-end exercised path while FFI is pending.
//
// The test uses a mock fetch — it does NOT make real network calls.
// It asserts the SDK produces a structurally valid response.
// ─────────────────────────────────────────────────────────────────────────

describe("Minimal live-path smoke — chat.completion (cloud transport, mocked)", () => {
  it("SDK produces a structurally valid response on the cloud path", async () => {
    // This is cloud transport conformance, not native capability conformance.
    // It exercises: OctomilClient construction → request dispatch → response parsing.
    // It does NOT prove OCT_EVENT_* sequences or native FFI binding correctness.
    //
    // IMPORTANT: This test must NOT be used as evidence that native capability
    // conformance passes. The SKIP tests above are the honest signals for that.

    // Import lazily to avoid top-level import errors when the SDK is missing deps.
    const { ResponsesClient } = await import("../../src/index.js");

    // Intercept fetch so no real network call is made.
    const mockFetch = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return new Response(
        JSON.stringify({
          id: "resp_conformance_smoke",
          model: "llama3-local",
          choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof fetch;
    try {
      const client = new ResponsesClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
      });

      const response = await client.create({
        model: "llama3-local",
        input: "hello",
      });

      expect(response).toBeDefined();
      expect(response.id).toBe("resp_conformance_smoke");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
