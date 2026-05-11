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

function requireStubLibrary(capabilities: string[], abiMinor = 9): string {
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
});
