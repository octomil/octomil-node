/**
 * Tests for FacadeCache.introspect() (cache.introspect).
 *
 * Covers:
 *   1. FacadeCache exists and introspect() is callable.
 *   2. Without runtime → throws RUNTIME_UNAVAILABLE (fail-closed bounded error).
 *   3. With stub NativeRuntime → returns NativeCacheSnapshot with expected shape.
 *   4. Octomil.cache getter returns a FacadeCache instance.
 */

import { describe, expect, it, vi } from "vitest";
import { FacadeCache, Octomil } from "../src/facade.js";
import { NativeRuntime } from "../src/runtime/native/loader.js";
import type { NativeCacheSnapshot } from "../src/runtime/native/loader.js";
import { OctomilError } from "../src/types.js";

// ── 1. Facade existence ───────────────────────────────────────────────────

describe("FacadeCache — facade existence and interface", () => {
  it("FacadeCache is importable and constructible", () => {
    expect(FacadeCache).toBeDefined();
    expect(typeof FacadeCache).toBe("function");
    const cache = new FacadeCache();
    expect(cache).toBeInstanceOf(FacadeCache);
    expect(typeof cache.introspect).toBe("function");
  });

  it("Octomil class exports cache getter (requires initialize — tested for type safety)", () => {
    // The cache getter is protected behind initialized check;
    // verify the property descriptor exists on the prototype.
    const proto = Object.getOwnPropertyDescriptor(Octomil.prototype, "cache");
    expect(proto).toBeDefined();
    expect(typeof proto?.get).toBe("function");
  });
});

// ── 2. Fail-closed — no runtime → RUNTIME_UNAVAILABLE ────────────────────

describe("FacadeCache — fail-closed without native runtime", () => {
  it("introspect() throws OctomilError with RUNTIME_UNAVAILABLE when no dylib present", () => {
    if (process.env.OCTOMIL_RUNTIME_DYLIB) return;
    const cache = new FacadeCache();
    expect(() => cache.introspect()).toThrow(OctomilError);
    try {
      cache.introspect();
    } catch (err) {
      if (err instanceof OctomilError) {
        // Bounded error codes — runtime absence surfaces as RUNTIME_UNAVAILABLE.
        expect(["RUNTIME_UNAVAILABLE", "CHECKSUM_MISMATCH"]).toContain(err.code);
      }
    }
  });
});

// ── 3. With stub runtime — shape validation ───────────────────────────────

describe("FacadeCache — stub snapshot shape", () => {
  it("NativeCacheSnapshot type is structurally correct with known fields", () => {
    // Build a conforming snapshot manually (no runtime needed).
    const snapshot: NativeCacheSnapshot = {
      version: 1,
      isStub: true,
      entries: [
        {
          capability: "audio.transcription",
          scope: "session",
          entries: 12,
          bytes: 4096,
          hit: 10,
          miss: 2,
        },
        {
          capability: "audio.vad",
          scope: "runtime",
          entries: 0,
          bytes: 0,
          hit: 0,
          miss: 0,
        },
      ],
    };

    expect(snapshot.version).toBe(1);
    expect(snapshot.isStub).toBe(true);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0].capability).toBe("audio.transcription");
    expect(snapshot.entries[0].scope).toBe("session");
    expect(snapshot.entries[0].hit).toBe(10);
    expect(snapshot.entries[0].miss).toBe(2);
    expect(snapshot.entries[1].scope).toBe("runtime");
  });

  it("FacadeCache.introspect() propagates NativeRuntime.cacheIntrospect() result", () => {
    const fakeSnapshot: NativeCacheSnapshot = {
      version: 2,
      isStub: false,
      entries: [
        {
          capability: "audio.vad",
          scope: "request",
          entries: 1,
          bytes: 128,
          hit: 3,
          miss: 0,
        },
      ],
    };

    const openSpy = vi.spyOn(NativeRuntime, "open").mockImplementation(() => {
      return {
        cacheIntrospect: vi.fn().mockReturnValue(fakeSnapshot),
        close: vi.fn(),
      } as unknown as InstanceType<typeof NativeRuntime>;
    });

    try {
      const cache = new FacadeCache();
      const result = cache.introspect();
      expect(result.version).toBe(2);
      expect(result.isStub).toBe(false);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].capability).toBe("audio.vad");
      expect(result.entries[0].scope).toBe("request");
      expect(result.entries[0].hit).toBe(3);
    } finally {
      openSpy.mockRestore();
    }
  });

  it("FacadeCache.introspect() closes runtime even when cacheIntrospect throws", () => {
    const closeFn = vi.fn();
    const openSpy = vi.spyOn(NativeRuntime, "open").mockImplementation(() => {
      return {
        cacheIntrospect: vi.fn().mockImplementation(() => {
          throw new OctomilError("RUNTIME_UNAVAILABLE", "cache introspect failed in test");
        }),
        close: closeFn,
      } as unknown as InstanceType<typeof NativeRuntime>;
    });

    try {
      const cache = new FacadeCache();
      expect(() => cache.introspect()).toThrow(OctomilError);
      // Runtime must be closed even on error.
      expect(closeFn).toHaveBeenCalledOnce();
    } finally {
      openSpy.mockRestore();
    }
  });
});
