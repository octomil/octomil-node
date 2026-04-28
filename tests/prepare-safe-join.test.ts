/**
 * Path-safety contract tests for the prepare lifecycle.
 *
 * These tests pin the cross-SDK invariants:
 *
 *   - structural traversal (`..`, `.`, empty segments, NUL, backslashes,
 *     absolute paths) is rejected before we touch the disk.
 *   - symlink-escape containment is enforced after the destination is
 *     created: a symlink inside the destination that points outside
 *     does NOT trick the materialization step.
 *
 * Mirrors Python's `_validate_relative_path` + `_safe_join`.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  safeJoinUnder,
  safeJoinUnderSync,
  validateRelativePath,
} from "../src/prepare/safe-join.js";
import { OctomilError } from "../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "octomil-safejoin-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("validateRelativePath", () => {
  it.each([
    ["empty string", ""],
    ["nul byte", "a\u0000b"],
    ["backslash", "a\\b"],
    ["dot segment", "a/./b"],
    ["dot-dot segment", "a/../b"],
    ["leading slash", "/abs"],
    ["empty middle segment", "a//b"],
    ["bare dot", "."],
    ["bare dot-dot", ".."],
  ])("rejects %s", (_label, input) => {
    expect(() => validateRelativePath(input)).toThrow(OctomilError);
  });

  it("accepts a vanilla relative path", () => {
    expect(validateRelativePath("a/b/c.bin")).toBe("a/b/c.bin");
  });
});

describe("safeJoinUnderSync", () => {
  it("rejects traversal even when the destination does not exist", () => {
    expect(() =>
      safeJoinUnderSync(path.join(tmpRoot, "missing"), "../escape"),
    ).toThrow(OctomilError);
  });

  it("returns a normalized in-tree path for vanilla input", () => {
    const out = safeJoinUnderSync(tmpRoot, "models/kokoro.onnx");
    expect(out).toBe(path.join(path.resolve(tmpRoot), "models", "kokoro.onnx"));
  });
});

describe("safeJoinUnder", () => {
  it("rejects a symlink inside destDir that escapes the artifact root", async () => {
    const inside = path.join(tmpRoot, "artifact");
    const outside = path.join(tmpRoot, "outside");
    await fsp.mkdir(inside, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    // Plant a symlink `inside/escape -> outside`. A bare structural
    // check would accept `escape/file.bin` because it has no `..`,
    // but the symlink-aware check must follow the link and reject.
    await fsp.symlink(outside, path.join(inside, "escape"));

    await expect(safeJoinUnder(inside, "escape/file.bin")).rejects.toBeInstanceOf(
      OctomilError,
    );
  });

  it("accepts an in-tree symlink", async () => {
    const inside = path.join(tmpRoot, "artifact");
    const subdir = path.join(inside, "subdir");
    await fsp.mkdir(subdir, { recursive: true });
    await fsp.symlink(subdir, path.join(inside, "linked"));

    const out = await safeJoinUnder(inside, "linked/file.bin");
    expect(out.startsWith(await fsp.realpath(inside))).toBe(true);
  });

  it("rejects traversal even after destDir creation", async () => {
    const inside = path.join(tmpRoot, "artifact");
    await fsp.mkdir(inside, { recursive: true });
    await expect(safeJoinUnder(inside, "../escape")).rejects.toBeInstanceOf(
      OctomilError,
    );
  });
});
