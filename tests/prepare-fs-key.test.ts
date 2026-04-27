/**
 * Tests for ``src/prepare/fs-key.ts`` — the shared filesystem-key
 * helper that PrepareManager and FileLock both consume. Mirrors the
 * Python ``tests/test_fs_key.py`` invariants so the two SDKs derive
 * the same key for the same artifact id.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_VISIBLE_CHARS, safeFilesystemKey } from "../src/prepare/fs-key.js";

describe("safeFilesystemKey", () => {
  it("preserves valid ASCII identifiers", () => {
    const key = safeFilesystemKey("kokoro-en-v0_19");
    // ``<visible>-<12-char hash>``
    expect(key).toMatch(/^kokoro-en-v0_19-[0-9a-f]{12}$/);
  });

  it("is deterministic across calls", () => {
    const a = safeFilesystemKey("kokoro-82m");
    const b = safeFilesystemKey("kokoro-82m");
    expect(a).toBe(b);
  });

  it("disambiguates different inputs that sanitize to the same visible name", () => {
    // Both sanitize to "model" but the SHA-256 prefix is taken over
    // the *original* string, so the keys differ.
    const a = safeFilesystemKey("model/v1");
    const b = safeFilesystemKey("model\\v1");
    expect(a).not.toBe(b);
    expect(a.split("-").pop()).not.toBe(b.split("-").pop());
  });

  it("replaces Windows-reserved characters with underscore", () => {
    const key = safeFilesystemKey('a<b>c:d"e/f\\g|h?i*j');
    expect(key).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{12}$/);
    // Each reserved char is replaced; trailing/leading underscores
    // are stripped from the visible portion.
    expect(key.startsWith("a")).toBe(true);
  });

  it("replaces non-ASCII characters with underscore", () => {
    const key = safeFilesystemKey("modèle-français-🎵");
    // Pure ASCII output guaranteed.
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("collapses empty / dot-only inputs to 'id-<hash>'", () => {
    expect(safeFilesystemKey("").startsWith("id-")).toBe(true);
    expect(safeFilesystemKey(".").startsWith("id-")).toBe(true);
    expect(safeFilesystemKey("..").startsWith("id-")).toBe(true);
    expect(safeFilesystemKey("   ").startsWith("id-")).toBe(true);
  });

  it("caps the visible portion at maxVisibleChars", () => {
    const longInput = "a".repeat(500);
    const key = safeFilesystemKey(longInput);
    // 96 visible + "-" + 12-char hash = 109 bytes max.
    expect(key.length).toBeLessThanOrEqual(DEFAULT_MAX_VISIBLE_CHARS + 13);
  });

  it("respects a custom maxVisibleChars", () => {
    const key = safeFilesystemKey("kokoro-en-v0_19", 5);
    // 5 visible + "-" + 12-char hash = 18 chars.
    expect(key.length).toBeLessThanOrEqual(5 + 13);
  });

  it("rejects NUL bytes with RangeError", () => {
    expect(() => safeFilesystemKey("foo\u0000bar")).toThrow(RangeError);
    expect(() => safeFilesystemKey("foo\u0000bar")).toThrow(/NUL byte/);
  });

  it("strips trailing underscores left over from sanitization", () => {
    // Trailing slashes get replaced with ``_``, then stripped.
    const key = safeFilesystemKey("model/");
    expect(key).toMatch(/^model-[0-9a-f]{12}$/);
  });

  it("strips leading underscores left over from sanitization", () => {
    const key = safeFilesystemKey("/model");
    expect(key).toMatch(/^model-[0-9a-f]{12}$/);
  });

  it("matches the Python implementation's hash for known inputs", () => {
    // Cross-SDK conformance: Python's
    // ``hashlib.sha256("kokoro-82m".encode()).hexdigest()[:12]``
    // is "64e5b12f9efb". Node's must agree.
    const key = safeFilesystemKey("kokoro-82m");
    expect(key).toBe("kokoro-82m-64e5b12f9efb");
  });
});
