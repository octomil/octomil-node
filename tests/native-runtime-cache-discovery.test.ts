/**
 * Tests for fetchedRuntimeLibraryCandidates() in loader.ts.
 *
 * Covers:
 *   - Empty / missing cache root returns [].
 *   - Flavor-keyed layout: <version>/<flavor>/lib/.extracted-ok is discovered.
 *   - Multiple flavors within a version are found (chat + stt).
 *   - Legacy layout: <version>/lib/.extracted-ok is still discovered.
 *   - Legacy and flavor-keyed layouts do not double-count the same version.
 *   - Version ordering: older versions come before newer ones (oldest-first).
 *   - Flavor ordering within a version: lexicographic (chat before stt).
 *   - Flavor without sentinel is skipped.
 *   - Non-directory entries in cache root are silently skipped.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fetchedRuntimeLibraryCandidates,
  ENV_RUNTIME_CACHE_DIR,
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

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "oct-cache-disc-test-"));
  origCacheDir = process.env[ENV_RUNTIME_CACHE_DIR];
  process.env[ENV_RUNTIME_CACHE_DIR] = tmp;
});

afterEach(async () => {
  if (origCacheDir === undefined) {
    delete process.env[ENV_RUNTIME_CACHE_DIR];
  } else {
    process.env[ENV_RUNTIME_CACHE_DIR] = origCacheDir;
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

  it("discovers both chat and stt entries for the same version", () => {
    const chatDylib = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const sttDylib = seedFlavorEntry(tmp, "v0.1.5", "stt");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(2);
    // Lexicographic order: chat before stt.
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

  it("orders older versions before newer versions", () => {
    const v14 = seedFlavorEntry(tmp, "v0.1.4", "chat");
    const v15 = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(v14);
    expect(result[1]).toBe(v15);
  });

  it("resolveNativeRuntimeLibrary picks newest version last candidate", () => {
    seedFlavorEntry(tmp, "v0.1.4", "chat");
    const newest = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    // The last element is the newest (oldest-first ordering).
    expect(result[result.length - 1]).toBe(newest);
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

  it("legacy version comes before newer flavor-keyed version in candidate list", () => {
    const legacy = seedLegacyEntry(tmp, "v0.1.4");
    const newChat = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(legacy);
    expect(result[1]).toBe(newChat);
  });

  it("flavor-keyed newer version is preferred over legacy older version (last-wins)", () => {
    seedLegacyEntry(tmp, "v0.1.4");
    const newFlavor = seedFlavorEntry(tmp, "v0.1.5", "chat");
    const result = fetchedRuntimeLibraryCandidates();
    expect(result[result.length - 1]).toBe(newFlavor);
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
