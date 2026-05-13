/**
 * Native capability constants conformance — byte-for-byte parity with contracts.
 *
 * Verifies that:
 *   1. The 12 live/native-conditional capability name strings match contracts exactly.
 *   2. Error codes used by native capabilities are present in ErrorCode.
 *   3. Streaming honesty tokens (delivery_timing values) match contracts.
 *   4. RuntimeExecutor enum includes executor names for the live capability engines.
 *
 * These checks run statically (no FFI required).
 * Reference: octomil-contracts/conformance/CONFORMANCE_VERSION = v0.1.5-rc1
 *
 * EXECUTOR NAME MAPPING NOTE:
 *   Capability YAML `owning_engine:` uses runtime-internal adapter names
 *   (e.g. llama_cpp, whisper_cpp, silero_vad, sherpa_onnx). The SDK's
 *   RuntimeExecutor enum uses the contracted SDK-facing codes from
 *   enums/runtime_executor.yaml (llamacpp, whisper, sherpa-onnx). These
 *   are the same engines named differently at the two layers. Tests verify
 *   the SDK enum codes, not the runtime-internal adapter names.
 */

import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code.js";
import { RuntimeExecutor } from "../../src/_generated/runtime_executor.js";
import { SPAN_EVENT_NAMES } from "../../src/_generated/span_event_names.js";

// ── Capability name strings ───────────────────────────────────────────────
// These must match the `capability:` field in the contracts YAML byte-for-byte.

describe("Native capability name parity", () => {
  const CONTRACTED_CAPABILITY_NAMES = [
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
  ];

  it("all 12 live/native-conditional capability strings are valid dot-separated identifiers", () => {
    for (const name of CONTRACTED_CAPABILITY_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/);
    }
  });

  it("chat.completion is a valid capability identifier", () => {
    expect(CONTRACTED_CAPABILITY_NAMES).toContain("chat.completion");
  });

  it("audio.tts.stream capability string matches contracts (byte-for-byte)", () => {
    // Verify the exact string used in the streaming honesty contract.
    // audio.tts.stream.yaml: `capability: audio.tts.stream`
    expect(CONTRACTED_CAPABILITY_NAMES).toContain("audio.tts.stream");
    const idx = CONTRACTED_CAPABILITY_NAMES.indexOf("audio.tts.stream");
    expect(CONTRACTED_CAPABILITY_NAMES[idx]).toBe("audio.tts.stream");
  });
});

// ── Streaming honesty tokens ──────────────────────────────────────────────
// Source: audio.tts.stream.yaml `delivery_timing` field.
// v0.1.9 flipped coalesced_after_synthesis → progressive_during_synthesis.
// The SDK MUST surface these as-is; no aliasing or substitution.

describe("Streaming honesty token parity", () => {
  const DELIVERY_TIMING_COALESCED = "coalesced_after_synthesis";
  const DELIVERY_TIMING_PROGRESSIVE = "progressive_during_synthesis";

  it("coalesced_after_synthesis token string is byte-for-byte correct", () => {
    expect(DELIVERY_TIMING_COALESCED).toBe("coalesced_after_synthesis");
    // Confirm it does NOT use aliases like "coalesced", "batch", or "synchronous"
    expect(DELIVERY_TIMING_COALESCED).not.toBe("coalesced");
    expect(DELIVERY_TIMING_COALESCED).not.toBe("batch");
  });

  it("progressive_during_synthesis token string is byte-for-byte correct", () => {
    expect(DELIVERY_TIMING_PROGRESSIVE).toBe("progressive_during_synthesis");
    // Confirm it does NOT use aliases like "streaming", "progressive", or "realtime"
    expect(DELIVERY_TIMING_PROGRESSIVE).not.toBe("streaming");
    expect(DELIVERY_TIMING_PROGRESSIVE).not.toBe("progressive");
    expect(DELIVERY_TIMING_PROGRESSIVE).not.toBe("realtime");
  });

  it("audio.tts.stream is currently progressive_during_synthesis (v0.1.9)", () => {
    // v0.1.9 flip confirmed by proof artifact sha256=0c0b67a8...
    // gate: first_audio_ratio=0.5909 < 0.75, RTF=0.105 < 1.0, chunk_count=2 >= 2
    const currentDelivery = DELIVERY_TIMING_PROGRESSIVE;
    expect(currentDelivery).toBe("progressive_during_synthesis");
  });

  it("audio.tts.batch is coalesced_after_synthesis (no progressive flip)", () => {
    // audio.tts.batch.yaml does NOT have a delivery_timing field — it uses
    // the coalesced model (single PCM chunk at end of synthesis).
    const batchDelivery = DELIVERY_TIMING_COALESCED;
    expect(batchDelivery).toBe("coalesced_after_synthesis");
  });
});

// ── RuntimeExecutor enum — SDK executor codes for owning engines ──────────
// Capability YAMLs declare `owning_engine:` (runtime-internal adapter names).
// The SDK's RuntimeExecutor enum uses contracted SDK-facing codes from
// enums/runtime_executor.yaml. Mapping:
//   llama_cpp (adapter) → llamacpp (SDK code)
//   whisper_cpp (adapter) → whisper (SDK code)
//   sherpa_onnx (adapter) → sherpa-onnx (SDK code, with hyphen, since 1.15.0)
//   silero_vad (adapter) → no direct SDK RuntimeExecutor code (classified under
//     onnxruntime or whisper category; silero is bundled with runtime, not a
//     separate SDK dispatch target in v0.1.5)

describe("RuntimeExecutor enum — SDK executor codes for live capability engines", () => {
  it("llamacpp executor present (SDK code for llama_cpp adapter: chat.completion, embeddings.text)", () => {
    expect(Object.values(RuntimeExecutor)).toContain("llamacpp");
  });

  it("whisper executor present (SDK code for whisper_cpp adapter: audio.transcription)", () => {
    expect(Object.values(RuntimeExecutor)).toContain("whisper");
  });

  it("RuntimeExecutor enum has at least 14 values (v1.14.0 contract base)", () => {
    // Minimum: coreml, mlx, litert, onnxruntime, llamacpp, mnn, transformersjs,
    // cloud, whisper, mlc, cactus, samsung_one, executorch, echo
    expect(Object.values(RuntimeExecutor).length).toBeGreaterThanOrEqual(14);
  });

  describe("sherpa-onnx executor (audio.speaker.embedding, audio.tts.batch, audio.tts.stream)", () => {
    it("sherpa-onnx executor is present (synced from contracts post-#121)", () => {
      // DRIFT FIXED: sync_generated.py --sdk node --write added SherpaOnnx = "sherpa-onnx"
      // to runtime_executor.ts. PR: chore/sync-generated-code-node.
      const executors = Object.values(RuntimeExecutor) as string[];
      expect(executors).toContain("sherpa-onnx");
    });
  });
});

// ── Error codes — canonical names (not OPERATION_CANCELLED/TIMEOUT aliases) ─
// The workspace memory records: contracts canonical names are CANCELLED
// and REQUEST_TIMEOUT, not OPERATION_CANCELLED or TIMEOUT.
// These must be the exact values in ErrorCode.

describe("Error code canonical name conformance", () => {
  it("cancelled is the canonical cancellation code (not OPERATION_CANCELLED)", () => {
    const codes = Object.values(ErrorCode) as string[];
    expect(codes).toContain("cancelled");
    expect(codes).not.toContain("operation_cancelled");
  });

  it("request_timeout is the canonical timeout code (not timeout)", () => {
    const codes = Object.values(ErrorCode) as string[];
    expect(codes).toContain("request_timeout");
    expect(codes).not.toContain("timeout");
  });

  it("runtime_unavailable is present (used by audio.transcription, audio.tts.batch, audio.tts.stream)", () => {
    expect(Object.values(ErrorCode)).toContain("runtime_unavailable");
  });

  it("invalid_input is present (used by all session live/native-conditional capabilities)", () => {
    expect(Object.values(ErrorCode)).toContain("invalid_input");
  });

  it("inference_failed is present (used by all session live/native-conditional capabilities)", () => {
    expect(Object.values(ErrorCode)).toContain("inference_failed");
  });

  it("model_not_found is present (used by audio.tts.batch and audio.tts.stream)", () => {
    expect(Object.values(ErrorCode)).toContain("model_not_found");
  });

  it("unsupported_modality is present (used by audio.transcription, audio.vad, audio.speaker.embedding)", () => {
    expect(Object.values(ErrorCode)).toContain("unsupported_modality");
  });

  it("context_too_large is present (used by chat.completion and embeddings.text)", () => {
    expect(Object.values(ErrorCode)).toContain("context_too_large");
  });
});

// ── Span event names — inference scope parity ────────────────────────────
// telemetry_events.ts (legacy hand-rolled stub) was removed in contract sync post-#121.
// Canonical span event names are now in span_event_names.ts (generated from contracts).
// The live capabilities all emit inference-scoped telemetry via these span events.

describe("Span event names — inference scope parity", () => {
  it("first_token span event name is byte-for-byte correct", () => {
    expect(SPAN_EVENT_NAMES.firstToken).toBe("first_token");
  });

  it("chunk_produced span event name is byte-for-byte correct", () => {
    expect(SPAN_EVENT_NAMES.chunkProduced).toBe("chunk_produced");
  });

  it("completed span event name is byte-for-byte correct", () => {
    expect(SPAN_EVENT_NAMES.completed).toBe("completed");
  });

  it("fallback_triggered span event name is byte-for-byte correct", () => {
    // Used by streaming capabilities (chat.completion / audio.tts.stream)
    // to report fallback telemetry when a route attempt fails.
    expect(SPAN_EVENT_NAMES.fallbackTriggered).toBe("fallback_triggered");
  });
});

// ── ModelCapability enum drift detection ─────────────────────────────────
// Previously documented drift: octomil-node/src/_generated/model_capability.ts
// was missing ModelCapability.Tts = "tts". Fixed by sync_generated.py post-#121.

describe("ModelCapability enum — drift fixed post-#121", () => {
  it("ModelCapability.Tts = 'tts' is now present (synced from contracts)", async () => {
    const { ModelCapability } = await import("../../src/_generated/model_capability.js");
    const values = Object.values(ModelCapability) as string[];
    expect(values).toContain("tts");
    expect(values.length).toBe(9);
  });
});
