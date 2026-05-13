/**
 * Tests for NativeTtsStreamBackend + NativeTtsStream (audio.tts.stream).
 *
 * Covers:
 *   1. Facade exists and is callable.
 *   2. Without runtime → throws RUNTIME_UNAVAILABLE (fail-closed bounded error).
 *   3. Voice validation (pre-flight, no runtime call).
 *   4. With stub NativeRuntime → lifecycle calls happen in order, chunks yielded.
 */

import { describe, expect, it, vi } from "vitest";
import { NativeTtsStream } from "../src/audio/audio-speech.js";
import {
  NativeTtsStreamBackend,
  TTS_FIRST_AUDIO_MS_METRIC_NAME,
} from "../src/runtime/native/tts_stream_backend.js";
import { OctomilError } from "../src/types.js";

// ── 1. Facade existence ───────────────────────────────────────────────────

describe("NativeTtsStream — facade existence and interface", () => {
  it("NativeTtsStream is importable and constructible", () => {
    expect(NativeTtsStream).toBeDefined();
    expect(typeof NativeTtsStream).toBe("function");
    const stream = new NativeTtsStream();
    expect(stream).toBeInstanceOf(NativeTtsStream);
    expect(typeof stream.stream).toBe("function");
    expect(typeof stream.streamAsync).toBe("function");
    expect(typeof stream.close).toBe("function");
  });

  it("NativeTtsStreamBackend is importable and constructible", () => {
    expect(NativeTtsStreamBackend).toBeDefined();
    const backend = new NativeTtsStreamBackend();
    expect(backend).toBeDefined();
    expect(typeof backend.loadModel).toBe("function");
    expect(typeof backend.validateVoice).toBe("function");
    expect(typeof backend.synthesizeWithChunks).toBe("function");
    expect(typeof backend.synthesizeStream).toBe("function");
    expect(typeof backend.close).toBe("function");
  });

  it("TTS_FIRST_AUDIO_MS_METRIC_NAME is exported", () => {
    expect(TTS_FIRST_AUDIO_MS_METRIC_NAME).toBe("tts.first_audio_ms");
  });
});

// ── 2. Fail-closed — no runtime → RUNTIME_UNAVAILABLE ────────────────────

describe("NativeTtsStreamBackend — fail-closed without native runtime", () => {
  it("loadModel() throws OctomilError when dylib absent", () => {
    if (process.env.OCTOMIL_RUNTIME_DYLIB) return;
    const backend = new NativeTtsStreamBackend();
    expect(() => backend.loadModel("sherpa-vits-base")).toThrow(OctomilError);
    try {
      backend.loadModel("sherpa-vits-base");
    } catch (err) {
      if (err instanceof OctomilError) {
        // Bounded: RUNTIME_UNAVAILABLE when dylib absent; INFERENCE_FAILED when
        // runtime opens but TTS capability not configured.
        expect(["RUNTIME_UNAVAILABLE", "CHECKSUM_MISMATCH", "INFERENCE_FAILED"]).toContain(err.code);
      }
    }
  });

  it("synthesizeWithChunks() throws RUNTIME_UNAVAILABLE before loadModel()", () => {
    const backend = new NativeTtsStreamBackend();
    expect(() => {
      // Generator must be iterated to throw.
      const gen = backend.synthesizeWithChunks("hello world");
      gen.next();
    }).toThrow(OctomilError);
    try {
      const gen = backend.synthesizeWithChunks("hello world");
      gen.next();
    } catch (err) {
      if (err instanceof OctomilError) {
        expect(err.code).toBe("RUNTIME_UNAVAILABLE");
      }
    }
  });

  it("NativeTtsStream.stream() throws when runtime absent", () => {
    if (process.env.OCTOMIL_RUNTIME_DYLIB) return;
    const stream = new NativeTtsStream();
    expect(() => {
      const gen = stream.stream({ model: "sherpa-vits-base", input: "hello" });
      gen.next();
    }).toThrow(OctomilError);
  });
});

// ── 3. Voice validation (pre-flight) ─────────────────────────────────────

describe("NativeTtsStreamBackend — voice validation", () => {
  it("validateVoice returns '0' for null/empty/undefined", () => {
    const backend = new NativeTtsStreamBackend();
    expect(backend.validateVoice(null)).toBe("0");
    expect(backend.validateVoice(undefined)).toBe("0");
    expect(backend.validateVoice("")).toBe("0");
    expect(backend.validateVoice("   ")).toBe("0");
  });

  it("validateVoice passes numeric strings through", () => {
    const backend = new NativeTtsStreamBackend();
    expect(backend.validateVoice("0")).toBe("0");
    expect(backend.validateVoice("42")).toBe("42");
    expect(backend.validateVoice("100")).toBe("100");
  });

  it("validateVoice throws INVALID_INPUT for non-numeric strings", () => {
    const backend = new NativeTtsStreamBackend();
    expect(() => backend.validateVoice("alice")).toThrow(OctomilError);
    expect(() => backend.validateVoice("voice-1")).toThrow(OctomilError);
    try {
      backend.validateVoice("alice");
    } catch (err) {
      if (err instanceof OctomilError) {
        expect(err.code).toBe("INVALID_INPUT");
      }
    }
  });

  it("synthesizeWithChunks() throws INVALID_INPUT for empty text", () => {
    const backend = new NativeTtsStreamBackend();
    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.tts.stream"],
      }),
      openSession: vi.fn(),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._model = mockModel;

    expect(() => {
      const gen = backend.synthesizeWithChunks("  ");
      gen.next();
    }).toThrow(OctomilError);
    try {
      const gen = backend.synthesizeWithChunks("  ");
      gen.next();
    } catch (err) {
      if (err instanceof OctomilError) {
        expect(err.code).toBe("INVALID_INPUT");
      }
    }
  });
});

// ── 4. With stub runtime — lifecycle order ────────────────────────────────

describe("NativeTtsStreamBackend — lifecycle with stub runtime", () => {
  function makePcmBuffer(samples = 16): Buffer {
    const buf = Buffer.alloc(samples * 4);
    for (let i = 0; i < samples; i++) {
      buf.writeFloatLE(0.1 * (i % 2 === 0 ? 1 : -1), i * 4);
    }
    return buf;
  }

  it("synthesizeWithChunks yields TtsAudioChunk objects, closes session on completion", () => {
    const pcm = makePcmBuffer(16);
    const mockSession = {
      sendText: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 }) // SESSION_STARTED
        .mockReturnValueOnce({
          type: 23, // OCT_EVENT_TTS_AUDIO_CHUNK
          ttsAudioChunk: {
            pcm,
            sampleRate: 22050,
            sampleFormat: 2, // PCM_F32LE
            channels: 1,
            isFinal: false,
          },
        })
        .mockReturnValueOnce({
          type: 23,
          ttsAudioChunk: {
            pcm,
            sampleRate: 22050,
            sampleFormat: 2,
            channels: 1,
            isFinal: true,
          },
        })
        .mockReturnValueOnce({
          type: 8, // SESSION_COMPLETED
          sessionCompleted: { terminalStatus: 0 },
        }),
      close: vi.fn(),
    };

    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.tts.stream"],
      }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };

    const backend = new NativeTtsStreamBackend();
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._model = mockModel;

    const chunks = Array.from(backend.synthesizeWithChunks("Hello world", { voiceId: "0" }));

    expect(mockRuntime.openSession).toHaveBeenCalledOnce();
    expect(mockSession.sendText).toHaveBeenCalledWith("Hello world");
    expect(mockSession.close).toHaveBeenCalledOnce();

    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].isFinal).toBe(false);
    expect(chunks[0].sampleRateHz).toBe(22050);
    expect(chunks[0].streamingMode).toBe("progressive");
    expect(chunks[0].pcmF32).toBeInstanceOf(Float32Array);

    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[1].isFinal).toBe(true);
    expect(chunks[1].cumulativeDurationMs).toBeGreaterThan(0);
  });

  it("synthesizeWithChunks throws INFERENCE_FAILED when SESSION_COMPLETED without isFinal chunk", () => {
    const mockSession = {
      sendText: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({ type: 8, sessionCompleted: { terminalStatus: 0 } }),
      close: vi.fn(),
    };

    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.tts.stream"],
      }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };

    const backend = new NativeTtsStreamBackend();
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._model = mockModel;

    expect(() => {
      const chunks = Array.from(backend.synthesizeWithChunks("Hi"));
      // Force generator to drain.
      return chunks;
    }).toThrow(OctomilError);
    try {
      Array.from(backend.synthesizeWithChunks("Hi"));
    } catch (err) {
      if (err instanceof OctomilError) {
        expect(err.code).toBe("INFERENCE_FAILED");
      }
    }
  });

  it("NativeTtsStream.stream() delegates to backend.synthesizeWithChunks", () => {
    const pcm = makePcmBuffer(8);
    const mockSession = {
      sendText: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({
          type: 23,
          ttsAudioChunk: { pcm, sampleRate: 24000, sampleFormat: 2, channels: 1, isFinal: true },
        })
        .mockReturnValueOnce({ type: 8, sessionCompleted: { terminalStatus: 0 } }),
      close: vi.fn(),
    };
    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.tts.stream"],
      }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };

    const nativeTts = new NativeTtsStream();
    const innerBackend = (nativeTts as unknown as Record<string, unknown>)._backend as Record<string, unknown>;
    innerBackend._runtime = mockRuntime;
    innerBackend._model = mockModel;
    (nativeTts as unknown as Record<string, unknown>)._loaded = true;
    (nativeTts as unknown as Record<string, unknown>)._currentModel = "sherpa-vits-base";

    const chunks = Array.from(
      nativeTts.stream({ model: "sherpa-vits-base", input: "Hello" }),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].isFinal).toBe(true);
    expect(chunks[0].sampleRateHz).toBe(24000);
  });

  // ── Regression: opts.speed must flow through synthesizeStream() ──────────
  // Prior to fix: synthesizeStream() dropped opts.speed when calling
  // synthesizeWithChunks, so speed was silently ignored. The fix: pass
  // speed through. We verify by spying on synthesizeWithChunks.

  it("synthesizeStream() forwards speed to synthesizeWithChunks (regression)", async () => {
    const pcm = makePcmBuffer(8);
    const mockSession = {
      sendText: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({
          type: 23,
          ttsAudioChunk: { pcm, sampleRate: 22050, sampleFormat: 2, channels: 1, isFinal: true },
        })
        .mockReturnValueOnce({ type: 8, sessionCompleted: { terminalStatus: 0 } }),
      close: vi.fn(),
    };
    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({ supportedCapabilities: ["audio.tts.stream"] }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };

    const backend = new NativeTtsStreamBackend();
    (backend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (backend as unknown as Record<string, unknown>)._model = mockModel;

    const synthesizeSpy = vi.spyOn(backend, "synthesizeWithChunks");

    // Collect async iterator
    const chunks: unknown[] = [];
    for await (const chunk of backend.synthesizeStream("Hello world", { voice: "0", speed: 1.5 })) {
      chunks.push(chunk);
    }

    // synthesizeWithChunks must have been called with speed forwarded.
    expect(synthesizeSpy).toHaveBeenCalledOnce();
    const callArgs = synthesizeSpy.mock.calls[0];
    expect(callArgs[1]).toMatchObject({ speed: 1.5 });

    synthesizeSpy.mockRestore();
  });

  it("NativeTtsStream.stream() forwards opts.speed to synthesizeWithChunks", () => {
    const pcm = makePcmBuffer(8);
    const mockSession = {
      sendText: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({
          type: 23,
          ttsAudioChunk: { pcm, sampleRate: 22050, sampleFormat: 2, channels: 1, isFinal: true },
        })
        .mockReturnValueOnce({ type: 8, sessionCompleted: { terminalStatus: 0 } }),
      close: vi.fn(),
    };
    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({ supportedCapabilities: ["audio.tts.stream"] }),
      openSession: vi.fn().mockReturnValue(mockSession),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };

    const nativeTts = new NativeTtsStream();
    const innerBackend = (nativeTts as unknown as Record<string, unknown>)._backend as NativeTtsStreamBackend;
    innerBackend._runtime = mockRuntime as unknown as typeof innerBackend._runtime;
    (innerBackend as unknown as Record<string, unknown>)._model = mockModel;
    (nativeTts as unknown as Record<string, unknown>)._loaded = true;
    (nativeTts as unknown as Record<string, unknown>)._currentModel = "sherpa-vits-base";

    const synthesizeSpy = vi.spyOn(innerBackend, "synthesizeWithChunks");

    Array.from(nativeTts.stream({ model: "sherpa-vits-base", input: "Hello", speed: 0.75 }));

    expect(synthesizeSpy).toHaveBeenCalledOnce();
    const callArgs = synthesizeSpy.mock.calls[0];
    // opts.speed must be forwarded, not dropped.
    expect(callArgs[1]).toMatchObject({ speed: 0.75 });

    synthesizeSpy.mockRestore();
  });

  // ── Regression: NativeTtsStream reloads model when model name changes ────

  it("NativeTtsStream.stream() reloads model when request.model changes", () => {
    const pcm = makePcmBuffer(8);
    const makeSession = () => ({
      sendText: vi.fn(),
      pollEvent: vi.fn()
        .mockReturnValueOnce({ type: 1 })
        .mockReturnValueOnce({
          type: 23,
          ttsAudioChunk: { pcm, sampleRate: 22050, sampleFormat: 2, channels: 1, isFinal: true },
        })
        .mockReturnValueOnce({ type: 8, sessionCompleted: { terminalStatus: 0 } }),
      close: vi.fn(),
    });

    const mockRuntime = {
      capabilities: vi.fn().mockReturnValue({
        supportedCapabilities: ["audio.tts.stream"],
      }),
      openSession: vi.fn().mockReturnValue(makeSession()),
      lastError: vi.fn().mockReturnValue(""),
      close: vi.fn(),
    };
    const mockModel = { warm: vi.fn(), close: vi.fn() };

    const nativeTts = new NativeTtsStream();
    const innerBackend = (nativeTts as unknown as Record<string, unknown>)._backend as NativeTtsStreamBackend;
    const loadModelSpy = vi.spyOn(innerBackend, "loadModel").mockImplementation(() => {
      // inject state so synthesizeWithChunks works
      (innerBackend as unknown as Record<string, unknown>)._runtime = mockRuntime;
      (innerBackend as unknown as Record<string, unknown>)._model = mockModel;
      (innerBackend as unknown as Record<string, unknown>)._modelName = "new-model";
    });

    // Simulate: was loaded with "sherpa-vits-base"
    (nativeTts as unknown as Record<string, unknown>)._loaded = true;
    (nativeTts as unknown as Record<string, unknown>)._currentModel = "sherpa-vits-base";
    (innerBackend as unknown as Record<string, unknown>)._runtime = mockRuntime;
    (innerBackend as unknown as Record<string, unknown>)._model = mockModel;
    // Reset mock session for second call
    mockRuntime.openSession.mockReturnValue(makeSession());

    // First call: same model → no reload
    Array.from(nativeTts.stream({ model: "sherpa-vits-base", input: "Hello" }));
    expect(loadModelSpy).not.toHaveBeenCalled();

    // Second call: different model → reload
    mockRuntime.openSession.mockReturnValue(makeSession());
    Array.from(nativeTts.stream({ model: "sherpa-vits-large", input: "World" }));
    expect(loadModelSpy).toHaveBeenCalledWith("sherpa-vits-large");

    loadModelSpy.mockRestore();
  });
});
