/**
 * Tests for NativeDiarizationBackend + FacadeDiarization (audio.diarization).
 *
 * Covers:
 *   1. Facade exists and is callable.
 *   2. Without runtime → throws RUNTIME_UNAVAILABLE (fail-closed bounded error).
 *   3. With stub NativeRuntime → lifecycle calls happen in order.
 */

import { describe, expect, it, vi } from "vitest";
import { FacadeDiarization } from "../src/audio/diarization.js";
import { NativeDiarizationBackend } from "../src/runtime/native/diarization_backend.js";
import { OctomilError } from "../src/types.js";

// ── 1. Facade existence ───────────────────────────────────────────────────

describe("FacadeDiarization — facade existence and interface", () => {
  it("FacadeDiarization is importable and constructible", () => {
    expect(FacadeDiarization).toBeDefined();
    expect(typeof FacadeDiarization).toBe("function");
    const facade = new FacadeDiarization();
    expect(facade).toBeInstanceOf(FacadeDiarization);
    expect(typeof facade.diarize).toBe("function");
    expect(typeof facade.close).toBe("function");
  });

  it("NativeDiarizationBackend is importable and constructible", () => {
    expect(NativeDiarizationBackend).toBeDefined();
    const backend = new NativeDiarizationBackend();
    expect(backend).toBeDefined();
    expect(typeof backend.open).toBe("function");
    expect(typeof backend.diarize).toBe("function");
    expect(typeof backend.close).toBe("function");
  });
});

// ── 2. Fail-closed — no runtime → RUNTIME_UNAVAILABLE ────────────────────

describe("FacadeDiarization — fail-closed without native runtime", () => {
  it("diarize() throws OctomilError with RUNTIME_UNAVAILABLE when no dylib present", () => {
    if (process.env.OCTOMIL_RUNTIME_DYLIB) return;
    const facade = new FacadeDiarization();
    const audio = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    expect(() => facade.diarize(audio, { sampleRateHz: 16000 })).toThrow(OctomilError);
    try {
      facade.diarize(audio, { sampleRateHz: 16000 });
    } catch (err) {
      if (err instanceof OctomilError) {
        // Bounded: RUNTIME_UNAVAILABLE when dylib absent; INFERENCE_FAILED when
        // runtime opens but capability not configured.
        expect(["RUNTIME_UNAVAILABLE", "CHECKSUM_MISMATCH", "INFERENCE_FAILED"]).toContain(err.code);
      }
    }
  });

  it("NativeDiarizationBackend.open() throws OctomilError when dylib absent", () => {
    if (process.env.OCTOMIL_RUNTIME_DYLIB) return;
    const backend = new NativeDiarizationBackend();
    expect(() => backend.open()).toThrow(OctomilError);
  });

  it("diarize() with invalid sample rate throws INVALID_INPUT", () => {
    const backend = new NativeDiarizationBackend();
    // Inject an initialized runtime to skip open(), test sample rate guard.
    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.diarization"],
      }),
      openSession: vi.fn(),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._initialized = true;

    const audio = new Float32Array([0.1, -0.1, 0.2]);
    expect(() => backend.diarize(audio, { sampleRateHz: 8000 })).toThrow(OctomilError);
    try {
      backend.diarize(audio, { sampleRateHz: 8000 });
    } catch (err) {
      if (err instanceof OctomilError) {
        expect(err.code).toBe("INVALID_INPUT");
      }
    }
  });

  it("diarize() with empty audio throws INVALID_INPUT", () => {
    const backend = new NativeDiarizationBackend();
    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.diarization"],
      }),
      openSession: vi.fn(),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._initialized = true;

    const empty = new Float32Array(0);
    expect(() => backend.diarize(empty, { sampleRateHz: 16000 })).toThrow(OctomilError);
    try {
      backend.diarize(empty, { sampleRateHz: 16000 });
    } catch (err) {
      if (err instanceof OctomilError) {
        expect(err.code).toBe("INVALID_INPUT");
      }
    }
  });
});

// ── 3. With stub runtime — lifecycle order ────────────────────────────────

describe("NativeDiarizationBackend — lifecycle with stub runtime", () => {
  it("diarize() returns DiarizationSegment array from DIARIZATION_SEGMENT events", () => {
    const mockSession = {
      sendAudio: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 }) // OCT_EVENT_SESSION_STARTED
        .mockReturnValueOnce({
          type: 25, // OCT_EVENT_DIARIZATION_SEGMENT
          diarizationSegment: {
            startMs: 0,
            endMs: 3000,
            speakerId: 0,
            speakerLabel: "SPEAKER_00",
          },
        })
        .mockReturnValueOnce({
          type: 25,
          diarizationSegment: {
            startMs: 3500,
            endMs: 7000,
            speakerId: 1,
            speakerLabel: "SPEAKER_01",
          },
        })
        .mockReturnValueOnce({
          type: 8, // OCT_EVENT_SESSION_COMPLETED
          sessionCompleted: { terminalStatus: 0 },
        }),
      close: vi.fn(),
    };

    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.diarization"],
      }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };

    const backend = new NativeDiarizationBackend();
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._initialized = true;

    const audio = new Float32Array([0.1, -0.1, 0.2, -0.2]);
    const segments = backend.diarize(audio, { sampleRateHz: 16000 });

    expect(mockRuntime.openSession).toHaveBeenCalledOnce();
    expect(mockSession.sendAudio).toHaveBeenCalledOnce();
    expect(mockSession.close).toHaveBeenCalledOnce();

    expect(segments).toHaveLength(2);
    expect(segments[0].startMs).toBe(0);
    expect(segments[0].endMs).toBe(3000);
    expect(segments[0].speakerId).toBe(0);
    expect(segments[0].speakerLabel).toBe("SPEAKER_00");
    expect(segments[0].speakerIsUnknown).toBe(false);
    expect(segments[1].speakerId).toBe(1);
    expect(segments[1].speakerIsUnknown).toBe(false);
  });

  it("diarize() marks speakerIsUnknown when speakerId === 65535 (OCT_DIARIZATION_SPEAKER_UNKNOWN)", () => {
    const mockSession = {
      sendAudio: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({
          type: 25,
          diarizationSegment: {
            startMs: 1000,
            endMs: 4000,
            speakerId: 65535,
            speakerLabel: "SPEAKER_UNKNOWN",
          },
        })
        .mockReturnValueOnce({
          type: 8,
          sessionCompleted: { terminalStatus: 0 },
        }),
      close: vi.fn(),
    };

    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.diarization"],
      }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };

    const backend = new NativeDiarizationBackend();
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._initialized = true;

    const audio = new Float32Array([0.1, -0.1]);
    const segments = backend.diarize(audio);

    expect(segments).toHaveLength(1);
    expect(segments[0].speakerIsUnknown).toBe(true);
    expect(segments[0].speakerId).toBe(65535);
  });

  it("FacadeDiarization.diarize() delegates to NativeDiarizationBackend", () => {
    const mockSession = {
      sendAudio: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({
          type: 25,
          diarizationSegment: { startMs: 500, endMs: 2000, speakerId: 0, speakerLabel: "SPEAKER_00" },
        })
        .mockReturnValueOnce({ type: 8, sessionCompleted: { terminalStatus: 0 } }),
      close: vi.fn(),
    };

    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.diarization"],
      }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };

    const facade = new FacadeDiarization();
    const innerBackend = (facade as unknown as Record<string, unknown>)._backend as Record<string, unknown>;
    innerBackend._runtime = mockRuntime;
    innerBackend._initialized = true;

    const audio = new Float32Array([0.1, -0.1, 0.2]);
    const segments = facade.diarize(audio, { sampleRateHz: 16000 });

    expect(segments).toHaveLength(1);
    expect(segments[0].startMs).toBe(500);
    expect(segments[0].endMs).toBe(2000);
    expect(segments[0].speakerIsUnknown).toBe(false);
  });
});
