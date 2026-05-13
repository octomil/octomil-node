import { describe, expect, it, vi } from "vitest";
import { RuntimeCapability } from "../../src/_generated/runtime_capability.js";
import { CapabilitiesClient } from "../../src/capabilities.js";
import {
  ENV_RUNTIME_DYLIB,
  NativeRuntime,
  NativeRuntimeError,
  discoverNativeRuntime,
  requireNativeCapability,
} from "../../src/runtime/native/index.js";
import { OctomilError } from "../../src/types.js";
import { buildNativeRuntimeStub } from "../helpers/native-runtime-stub.js";

function requireStubLibrary(capabilities: string[], abiMinor = 10): string {
  const libraryPath = buildNativeRuntimeStub({
    abiMinor,
    capabilities,
    engines: capabilities.length > 0 ? ["llama_cpp"] : [],
    archs: ["darwin-arm64"],
  });
  if (!libraryPath) {
    throw new Error(
      "native runtime bridge conformance requires cc/clang/gcc to build the C ABI smoke stub",
    );
  }
  return libraryPath;
}

describe("Node native runtime bridge conformance", () => {
  it("discovers capabilities from the loaded C ABI and filters unknown advertisements", () => {
    const libraryPath = requireStubLibrary([
      "chat.completion",
      "octomil.future.capability",
    ]);

    const runtime = NativeRuntime.open({ libraryPath });
    try {
      const caps = runtime.capabilities();
      expect(caps.supportedCapabilities).toEqual([
        RuntimeCapability.ChatCompletion,
      ]);
      expect(caps.unknownCapabilities).toEqual(["octomil.future.capability"]);
      expect(caps.supportedEngines).toEqual(["llama_cpp"]);
      expect(caps.hasMetal).toBe(true);
    } finally {
      runtime.close();
    }
  });

  it("fails closed when abi is read after close", () => {
    const libraryPath = requireStubLibrary(["chat.completion"]);
    const runtime = NativeRuntime.open({ libraryPath });

    runtime.close();

    expect(() => runtime.abi).toThrow(NativeRuntimeError);
    expect(() => runtime.abi).toThrow(/Native runtime handle is closed/);
  });

  it("wires capabilities.current to real native SDK output without claiming browser native support", () => {
    const libraryPath = requireStubLibrary(["chat.completion"]);
    vi.stubEnv(ENV_RUNTIME_DYLIB, libraryPath);

    try {
      const profile = new CapabilitiesClient().current();
      expect(profile.availableRuntimes).toContain("octomil-native");
      expect(profile.availableRuntimes).not.toContain("browser-native");
      expect(profile.nativeRuntime.runtimeKind).toBe("node-native");
      expect(profile.nativeRuntime.available).toBe(true);
      expect(profile.nativeRuntime.capabilities?.supportedCapabilities).toEqual(
        [RuntimeCapability.ChatCompletion],
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when the native library is absent", () => {
    vi.stubEnv(
      ENV_RUNTIME_DYLIB,
      "/definitely/missing/liboctomil-runtime.dylib",
    );

    try {
      const discovery = discoverNativeRuntime();
      expect(discovery.available).toBe(false);
      expect(discovery.unsupportedCode).toBe("RUNTIME_UNAVAILABLE");

      expect(() => NativeRuntime.open()).toThrow(OctomilError);
      expect(() => NativeRuntime.open()).toThrow(
        /RUNTIME_UNAVAILABLE|does not exist/,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails closed when artifacts are absent and no capability is advertised", () => {
    const libraryPath = requireStubLibrary([]);

    expect(() =>
      requireNativeCapability(RuntimeCapability.ChatCompletion, {
        libraryPath,
      }),
    ).toThrow(NativeRuntimeError);
    expect(() =>
      requireNativeCapability(RuntimeCapability.ChatCompletion, {
        libraryPath,
      }),
    ).toThrow(/does not advertise required capability chat\.completion/);
  });

  it("rejects incompatible ABI before opening a runtime handle", () => {
    const libraryPath = requireStubLibrary(["chat.completion"], 8);
    const discovery = discoverNativeRuntime({ libraryPath });

    expect(discovery.available).toBe(false);
    expect(discovery.unsupportedCode).toBe("RUNTIME_UNAVAILABLE");
    expect(discovery.unsupportedReason).toContain("ABI 0.8.0");
  });

  it("opens model/session handles and parses lifecycle events from the native ABI", () => {
    const libraryPath = requireStubLibrary([
      "chat.completion",
      "audio.diarization",
      "embeddings.text",
      "audio.transcription",
      "audio.vad",
      "audio.speaker.embedding",
      "audio.tts.batch",
      "audio.tts.stream",
    ]);

    const runtime = NativeRuntime.open({ libraryPath });
    try {
      const model = runtime.openModel({
        modelUri: "file:///stub/model.gguf",
      });
      model.warm();

      const session = runtime.openSession({
        capability: "audio.diarization",
        model,
        modelUri: "file:///stub/model.gguf",
      });
      try {
        session.sendAudio(new Float32Array([0.2, -0.2, 0.3, -0.3]), 16_000, 1);

        const first = session.pollEvent(0);
        const second = session.pollEvent(0);
        const third = session.pollEvent(0);

        expect(first.type).toBe(1);
        expect(second.diarizationSegment?.speakerLabel).toBe("SPEAKER_00");
        expect(third.sessionCompleted?.terminalStatus).toBe(0);
      } finally {
        session.close();
      }

      expect(model.close()).toBe(0);
    } finally {
      runtime.close();
    }
  });

  it("treats audio.stt.batch as a session-capable alias of audio.transcription", () => {
    const libraryPath = requireStubLibrary([
      "audio.transcription",
      "audio.stt.batch",
    ]);

    const runtime = NativeRuntime.open({ libraryPath });
    try {
      const model = runtime.openModel({
        modelUri: "file:///stub/audio-stt-batch.gguf",
      });
      model.warm();

      const session = runtime.openSession({
        capability: "audio.stt.batch",
        model,
        modelUri: "file:///stub/audio-stt-batch.gguf",
      });
      try {
        session.sendAudio(new Float32Array([0.1, -0.1, 0.2, -0.2]), 16_000, 1);

        const events = [session.pollEvent(0), session.pollEvent(0), session.pollEvent(0), session.pollEvent(0)];
        expect(events[0]?.type).toBe(1);
        expect(events[1]?.transcriptSegment?.text).toBe("segment");
        expect(events[2]?.transcriptFinal?.nSegments).toBe(1);
        expect(events[3]?.sessionCompleted?.terminalStatus).toBe(0);
      } finally {
        session.close();
      }

      model.close();
    } finally {
      runtime.close();
    }
  });

  it("exposes cache clear/introspect wrappers over the native ABI", () => {
    const libraryPath = requireStubLibrary(["cache.introspect"]);
    const runtime = NativeRuntime.open({ libraryPath });

    try {
      const snapshot = runtime.cacheIntrospect();
      expect(snapshot).toEqual({
        version: 1,
        isStub: true,
        entries: [],
      });

      expect(() => runtime.cacheClearAll()).toThrow(NativeRuntimeError);
      expect(() => runtime.cacheClearAll()).toThrow(/OCT_STATUS_UNSUPPORTED/);
      expect(() => runtime.cacheClearCapability("chat.completion")).toThrow(NativeRuntimeError);
      expect(() => runtime.cacheClearCapability("chat.completion")).toThrow(/OCT_STATUS_UNSUPPORTED/);
      expect(() => runtime.cacheClearScope(0)).toThrow(NativeRuntimeError);
      expect(() => runtime.cacheClearScope(0)).toThrow(/OCT_STATUS_UNSUPPORTED/);
    } finally {
      runtime.close();
    }
  });
});
