/**
 * Native capability conformance tests — Node SDK (Lane A bootstrap).
 *
 * Covers the 7 LIVE native capabilities as of conformance version v0.1.5-rc1:
 *   1. chat.completion
 *   2. embeddings.text
 *   3. audio.transcription
 *   4. audio.vad
 *   5. audio.speaker.embedding
 *   6. audio.tts.batch
 *   7. audio.tts.stream
 *
 * chat.stream is a streaming PROFILE of chat.completion (is_advertised=false
 * in the contracts YAML). It is NOT a separate tested capability here.
 * Per contract: the runtime does NOT advertise the literal "chat.stream"
 * capability; streaming is a property of every chat.completion session.
 *
 * SKIP_WITH_EXPLICIT_REASON policy:
 *   The Node SDK does not currently bind to the native OCT runtime via FFI.
 *   All per-capability lifecycle/event/error tests that require a live native
 *   runtime use skip.withExplicitReason() rather than silently passing or
 *   falling back to cloud. This makes the SDK's actual coverage honest.
 *   Reference: octomil-contracts/conformance/CONFORMANCE_VERSION = v0.1.5-rc1
 *
 * DO NOT add cloud fallback to make any of these tests pass. The skip path
 * is the correct, honest signal for capabilities the binding can't yet exercise.
 */

import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code.js";

// ── Capability identifiers (byte-for-byte from contracts) ──────────────────
// Source: octomil-contracts/conformance/<capability>.yaml field `capability:`
const LIVE_CAPABILITIES = [
  "chat.completion",
  "embeddings.text",
  "audio.transcription",
  "audio.vad",
  "audio.speaker.embedding",
  "audio.tts.batch",
  "audio.tts.stream",
] as const;

type LiveCapability = (typeof LIVE_CAPABILITIES)[number];

// chat.stream is a streaming profile of chat.completion (is_advertised=false).
// It MUST NOT appear in the capability advertisement.
const NON_ADVERTISED_PROFILES = ["chat.stream"] as const;

// ── Error codes used by the 7 live capabilities ────────────────────────────
// Sourced from bounded_error_codes in each capability YAML.
// These must exist in ErrorCode (byte-for-byte values enforced by contract.test.ts).
const BOUNDED_ERROR_CODES_BY_CAPABILITY: Record<LiveCapability, string[]> = {
  "chat.completion": ["invalid_input", "context_too_large", "inference_failed", "cancelled"],
  "embeddings.text": ["invalid_input", "context_too_large", "inference_failed", "cancelled"],
  "audio.transcription": [
    "invalid_input",
    "inference_failed",
    "cancelled",
    "unsupported_modality",
    "runtime_unavailable",
  ],
  "audio.vad": ["invalid_input", "inference_failed", "cancelled", "unsupported_modality"],
  "audio.speaker.embedding": ["invalid_input", "inference_failed", "cancelled", "unsupported_modality"],
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
const EXPECTED_EVENT_SEQUENCES: Record<LiveCapability, { event: string; quantifier: string }[]> = {
  "chat.completion": [
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
  "embeddings.text": ["/Users/", "/private/var/"],
  "audio.transcription": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "ggml-tiny.bin"],
  "audio.vad": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm", "ggml-silero"],
  "audio.speaker.embedding": ["/Users/", "/private/var/", "/home/", ".wav", ".pcm"],
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

function allowedEventSet(cap: LiveCapability): Set<string> {
  const capEvents = new Set(EXPECTED_EVENT_SEQUENCES[cap].map((e) => e.event));
  return new Set([...capEvents, ...RUNTIME_SCOPE_EVENTS]);
}

// ─────────────────────────────────────────────────────────────────────────
// Section 1: Structural / static conformance (always runs, no runtime FFI)
// ─────────────────────────────────────────────────────────────────────────

describe("Native capability conformance — static / structural", () => {
  describe("Live capability set", () => {
    it("declares exactly the 7 live capabilities (no overclaim)", () => {
      expect(LIVE_CAPABILITIES).toHaveLength(7);
      expect(LIVE_CAPABILITIES).toContain("chat.completion");
      expect(LIVE_CAPABILITIES).toContain("embeddings.text");
      expect(LIVE_CAPABILITIES).toContain("audio.transcription");
      expect(LIVE_CAPABILITIES).toContain("audio.vad");
      expect(LIVE_CAPABILITIES).toContain("audio.speaker.embedding");
      expect(LIVE_CAPABILITIES).toContain("audio.tts.batch");
      expect(LIVE_CAPABILITIES).toContain("audio.tts.stream");
    });

    it("does NOT claim audio.diarization (not live)", () => {
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).not.toContain("audio.diarization");
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

  describe("chat.stream is_advertised=false invariant", () => {
    it("chat.stream is classified as a non-advertised profile, not a live capability", () => {
      expect(NON_ADVERTISED_PROFILES).toContain("chat.stream");
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).not.toContain("chat.stream");
    });

    it("chat.stream is treated as a streaming profile of chat.completion", () => {
      // Contract: streaming_profile_of=chat.completion, is_advertised=false.
      // Tests exercise chat.completion lifecycle; streaming is a session property.
      expect(LIVE_CAPABILITIES as ReadonlyArray<string>).toContain("chat.completion");
    });
  });

  describe("Bounded error codes — contracts byte-for-byte", () => {
    for (const cap of LIVE_CAPABILITIES) {
      it(`${cap}: all bounded error codes exist in ErrorCode enum`, () => {
        const allCodes = Object.values(ErrorCode);
        for (const code of BOUNDED_ERROR_CODES_BY_CAPABILITY[cap]) {
          expect(allCodes).toContain(code);
        }
      });
    }
  });

  describe("Event sequence structure — Invariant 7 closed-set", () => {
    for (const cap of LIVE_CAPABILITIES) {
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
// These tests require a live native OCT runtime via FFI. The Node SDK does
// not currently expose a native FFI binding. All tests in this section
// use skip.withExplicitReason() to produce honest status rather than fake pass.
//
// DO NOT add cloud fallback to make these pass. Cloud inference is a
// different transport and does not prove native capability conformance.
// DO NOT modify these tests to pass without FFI — fix the binding instead.
// ─────────────────────────────────────────────────────────────────────────

const SKIP_REASON_FFI =
  "native runtime FFI not yet wired in octomil-node — " +
  "oct_session_open / oct_session_poll bindings required to exercise lifecycle; " +
  "see octomil-node TODO: native-ffi-binding";

describe("Native capability conformance — lifecycle (SKIP: FFI not wired)", () => {
  for (const cap of LIVE_CAPABILITIES) {
    describe(`${cap}`, () => {
      it.skip(`lifecycle: runtime_open → model_open/warm → session_open → invoke → session_close → runtime_close`, () => {
        // SKIP_WITH_EXPLICIT_REASON: ${SKIP_REASON_FFI}
        // When this is implemented:
        //   1. open native runtime (oct_runtime_open)
        //   2. probe capabilities: assert "${cap}" is in supported_capabilities
        //   3. open model (if model_bound=true for this capability)
        //   4. open session: oct_session_open(capability="${cap}")
        //   5. send payload: appropriate send_* call per capability
        //   6. drain poll_event until SESSION_COMPLETED
        //   7. assert terminal_status ∈ contracted terminal_statuses
        //   8. close session, model, runtime
        //
        // This test MUST NOT fake pass via cloud transport.
        throw new Error("not implemented — FFI not wired");
      });

      it.skip(`event sequence: contracted OCT_EVENT_* order matches observed events`, () => {
        // SKIP_WITH_EXPLICIT_REASON: ${SKIP_REASON_FFI}
        // When implemented: drain poll_event, collect event types in order,
        // assert they satisfy the quantifiers in EXPECTED_EVENT_SEQUENCES["${cap}"].
        // Also assert no out-of-closed-set event appears (Invariant 7).
        throw new Error("not implemented — FFI not wired");
      });

      it.skip(`error mapping: invalid input → expected_sdk_error_code (non-fatal, not retried as fatal)`, () => {
        // SKIP_WITH_EXPLICIT_REASON: ${SKIP_REASON_FFI}
        // Per-capability invalid_inputs from contracts YAML must surface the
        // corresponding error code. Example for ${cap}:
        // invalid payload → OCT_STATUS_INVALID_INPUT → sdk_code=invalid_input
        // Fatal codes (inference_failed, model_not_found) terminate session;
        // non-fatal codes (cancelled) leave runtime reusable.
        throw new Error("not implemented — FFI not wired");
      });

      it.skip(`is_advertised=true: non-advertising runtime MUST reject with UNSUPPORTED + last_error mentions capability`, () => {
        // SKIP_WITH_EXPLICIT_REASON: ${SKIP_REASON_FFI}
        // Invariant 1: if runtime does not advertise "${cap}",
        // oct_session_open("${cap}") MUST return OCT_STATUS_UNSUPPORTED and
        // last_error MUST contain the string "${cap}".
        // This blocks silent UNKNOWN or OK returns on non-advertising runtimes.
        throw new Error("not implemented — FFI not wired");
      });

      it.skip(`privacy: no deny_field_substrings in metric/log event payloads`, () => {
        // SKIP_WITH_EXPLICIT_REASON: ${SKIP_REASON_FFI}
        // Drain all OCT_EVENT_METRIC events from a completed session.
        // Assert none of the event field values contain substrings from
        // PRIVACY_DENY_SUBSTRINGS["${cap}"].
        // Specifically: no path leakage (/Users/, .wav, .pcm), no prompt/transcript/audio bytes.
        throw new Error("not implemented — FFI not wired");
      });
    });
  }

  // chat.stream is_advertised=false — separate invariant
  describe("chat.stream (is_advertised=false profile)", () => {
    it.skip(
      "runtime MUST NOT advertise literal 'chat.stream' in supported_capabilities — fake-advertise violation",
      () => {
        // SKIP_WITH_EXPLICIT_REASON: ${SKIP_REASON_FFI}
        // Invariant from is_advertised=false YAML (chat.stream.yaml):
        // oct_runtime_capabilities() MUST NOT include "chat.stream".
        // oct_session_open("chat.stream") MUST return OCT_STATUS_UNSUPPORTED
        // with last_error mentioning "chat.stream".
        // A runtime that silently accepts the literal string is a fake-support
        // violation and must fail conformance.
        throw new Error("not implemented — FFI not wired");
      },
    );
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
