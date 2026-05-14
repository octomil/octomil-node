/**
 * Tests for fetchedRuntimeLibraryCandidates() in loader.ts.
 *
 * Covers:
 *   - Empty / missing cache root returns [].
 *   - Flavor-keyed layout: <version>/<flavor>/lib/.extracted-ok is discovered.
 *   - Multiple flavors within a version: chat preferred over stt by default.
 *   - Legacy layout: <version>/lib/.extracted-ok is still discovered.
 *   - Legacy and flavor-keyed layouts do not double-count the same version.
 *   - Version ordering: newest versions come first (newest-first).
 *   - Flavor preference within a version: chat before stt (FLAVOR_PREFERENCE order).
 *   - Flavor without sentinel is skipped.
 *   - Non-directory entries in cache root are silently skipped.
 *   - OCTOMIL_RUNTIME_FLAVOR env var: filters to the requested flavor only.
 *   - OCTOMIL_RUNTIME_FLAVOR=invalid: throws a clear error.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fetchedRuntimeLibraryCandidates,
  ENV_RUNTIME_CACHE_DIR,
  ENV_RUNTIME_FLAVOR,
} from "../src/runtime/native/loader.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const DYLIB = process.platform === "darwin"
  ? "liboctomil-runtime.dylib"
  : "liboctomil-runtime.so";

const SENTINEL = ".extracted-ok";

/** Seed a flavour-keyed cache entry: <root>/<version>/<flavor>/lib/{dylib,sentinel} */
function seedFlavorEntry(root: string, version: string, flavor: string): string {
  const libDir = path.join(root, version, flavor, "lib");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(path.join(libDir, DYLIB), `fake-${flavor}`);
  writeFileSync(path.join(libDir, SENTINEL), version + "\n");
  return path.join(libDir, DYLIB);
}

/** Seed a legacy (pre-flavor) cache entry: <root>/<version>/lib/{dylib,sentinel} */
function seedLegacyEntry(root: string, version: string): string {
  const libDir = path.join(root, version, "lib");
  mkdirSync(libDir, { recursive: true });
  writeFileSync(path.join(libDir, DYLIB), "fake-legacy");
  writeFileSync(path.join(libDir, SENTINEL), version + "\n");
  return path.join(libDir, DYLIB);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmp: string;
let origCacheDir: string | undefined;
let origFlavorOverride: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oct-cache-disc-test-"));
  origCacheDir = process.env[ENV_RUNTIME_CACHE_DIR];
  origFlavorOverride = process.env[ENV_RUNTIME_FLAVOR];
  process.env[ENV_RUNTIME_CACHE_DIR] = tmp;
  delete process.env[ENV_RUNTIME_FLAVOR];
});

afterEach(async () => {
  if (origCacheDir === undefined) {
    delete process.env[ENV_RUNTIME_CACHE_DIR];
  } else {
    process.env[ENV_RUNTIME_CACHE_DIR] = origCacheDir;
  }
  if (origFlavorOverride === undefined) {
    delete process.env[ENV_RUNTIME_FLAVOR];
  } else {
    process.env[ENV_RUNTIME_FLAVOR] = origFlavorOverride;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchedRuntimeLibraryCandidates — empty / missing root", () => {
  it("returns [] when cache root does not exist", async () => {
    process.env[ENV_RUNTIME_CACHE_DIR] = path.join(tmp, "nonexistent");
    expect(fetchedRuntimeLibraryCandidates()).toEqual([]);
  });

  it("returns [] when cache root is empty", () => {
    expect(fetchedRuntimeLibraryCandidates()).toEqual([]);
  });
});

describe("fetchedRuntimeLibraryCandidates — flavor-keyed layout", () => {
  it("discovers a single flavor-keyed entry", () => {
    const dylib = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(dylib);
  });

  it("prefers chat over stt when both flavors are cached for the same version", () => {
    // Regression: before fix, stt was returned as default (lexicographic last
    // + last-wins), silently breaking client.chat and client.embeddings.
    const chatDylib = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const sttDylib = seedFlavorEntry(tmp, "v0.1.5", "stt");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(2);
    // chat must be at index 0 — it is the preferred default.
    expect(result[0]).toBe(chatDylib);
    expect(result[1]).toBe(sttDylib);
  });

  it("skips a flavor dir that has dylib but no sentinel", () => {
    // chat has sentinel; stt does not.
    const chatDylib = seedFlavorEntry(tmp, "v0.1.5", "chat");
    // stt: write dylib but no sentinel.
    const sttLibDir = path.join(tmp, "v0.1.5", "stt", "lib");
    mkdirSync(sttLibDir, { recursive: true });
    writeFileSync(path.join(sttLibDir, DYLIB), "fake-stt-no-sentinel");

    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(chatDylib);
  });

  it("orders newer versions before older versions (newest-first)", () => {
    const v14 = seedFlavorEntry(tmp, "v0.1.4", "chat");
    const v15 = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(2);
    // Newest version first.
    expect(result[0]).toBe(v15);
    expect(result[1]).toBe(v14);
  });

  it("resolveNativeRuntimeLibrary picks newest version — it is index 0", () => {
    seedFlavorEntry(tmp, "v0.1.4", "chat");
    const newest = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    // With newest-first ordering, the best candidate is always at index 0.
    expect(result[0]).toBe(newest);
  });
});

describe("fetchedRuntimeLibraryCandidates — legacy layout backward-compat", () => {
  it("discovers legacy <version>/lib/ layout (no flavor subdir)", () => {
    const legacyDylib = seedLegacyEntry(tmp, "v0.1.4");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(legacyDylib);
  });

  it("legacy version dir is consumed without double-counting its lib/ as a flavor dir", () => {
    // Before the fix: the old layout has <version>/lib/ which could look like
    // a "lib" flavor subdir. The loader must treat it as legacy (not also walk
    // it as a flavor dir named "lib").
    const legacyDylib = seedLegacyEntry(tmp, "v0.1.4");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result).toContain(legacyDylib);
  });

  it("newer flavor-keyed version comes before older legacy version in candidate list", () => {
    const legacy = seedLegacyEntry(tmp, "v0.1.4");
    const newChat = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(2);
    // Newest-first: flavor-keyed v0.1.5 at index 0, legacy v0.1.4 at index 1.
    expect(result[0]).toBe(newChat);
    expect(result[1]).toBe(legacy);
  });

  it("flavor-keyed newer version is preferred over legacy older version (first-wins)", () => {
    seedLegacyEntry(tmp, "v0.1.4");
    const newFlavor = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    // With newest-first ordering, the preferred candidate is at index 0.
    expect(result[0]).toBe(newFlavor);
  });
});

describe("fetchedRuntimeLibraryCandidates — robustness", () => {
  it("ignores non-directory files in cache root", async () => {
    // Write a file (not a directory) directly in the cache root.
    writeFileSync(path.join(tmp, "stray-file.txt"), "noise");
    seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    // Only the real entry — the stray file is silently skipped.
    expect(result).toHaveLength(1);
  });
});

describe("fetchedRuntimeLibraryCandidates — OCTOMIL_RUNTIME_FLAVOR env var", () => {
  it("OCTOMIL_RUNTIME_FLAVOR=stt returns only stt even though chat is also cached", () => {
    // Regression: without the fix, the default picks chat. With the override
    // set to stt, only stt candidates must be returned.
    seedFlavorEntry(tmp, "v0.1.5", "chat");
    const sttDylib = seedFlavorEntry(tmp, "v0.1.5", "stt");
    process.env[ENV_RUNTIME_FLAVOR] = "stt";
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sttDylib);
  });

  it("OCTOMIL_RUNTIME_FLAVOR=chat returns only chat", () => {
    const chatDylib = seedFlavorEntry(tmp, "v0.1.5", "chat");
    seedFlavorEntry(tmp, "v0.1.5", "stt");
    process.env[ENV_RUNTIME_FLAVOR] = "chat";
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(chatDylib);
  });

  it("OCTOMIL_RUNTIME_FLAVOR=stt still works when only stt is cached (no chat present)", () => {
    const sttDylib = seedFlavorEntry(tmp, "v0.1.5", "stt");
    process.env[ENV_RUNTIME_FLAVOR] = "stt";
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sttDylib);
  });

  it("OCTOMIL_RUNTIME_FLAVOR=invalid throws a clear error", () => {
    seedFlavorEntry(tmp, "v0.1.5", "chat");
    process.env[ENV_RUNTIME_FLAVOR] = "invalid-flavor";
    expect(() => fetchedRuntimeLibraryCandidates()).toThrow(
      /OCTOMIL_RUNTIME_FLAVOR.*invalid-flavor/,
    );
  });

  it("OCTOMIL_RUNTIME_FLAVOR=stt override works with mixed legacy + flavor-keyed cache", () => {
    // Legacy entry (treated as chat) should be excluded; only stt from v0.1.5.
    seedLegacyEntry(tmp, "v0.1.4");
    const sttDylib = seedFlavorEntry(tmp, "v0.1.5", "stt");
    process.env[ENV_RUNTIME_FLAVOR] = "stt";
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sttDylib);
  });

  it("OCTOMIL_RUNTIME_FLAVOR=chat override includes legacy entry (treated as chat-compatible)", () => {
    const legacyDylib = seedLegacyEntry(tmp, "v0.1.4");
    seedFlavorEntry(tmp, "v0.1.5", "stt"); // stt should be excluded
    const chatDylib = seedFlavorEntry(tmp, "v0.1.5", "chat");
    process.env[ENV_RUNTIME_FLAVOR] = "chat";
    const result = fetchedRuntimeLibraryCandidates();
    // v0.1.5/chat + v0.1.4 legacy; stt excluded
    expect(result).toHaveLength(2);
    expect(result).toContain(chatDylib);
    expect(result).toContain(legacyDylib);
    expect(result).not.toContain(path.join(tmp, "v0.1.5", "stt", "lib", DYLIB));
  });
});
