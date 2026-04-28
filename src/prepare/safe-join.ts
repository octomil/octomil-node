/**
 * Path-safety helpers for the Node prepare lifecycle.
 *
 * Mirrors Python's `_validate_relative_path` + `_safe_join` (see
 * `octomil/runtime/lifecycle/durable_download.py`) so the two SDKs apply
 * the same containment contract:
 *
 *   1. Structural validation rejects traversal (`..`), absolute paths,
 *      backslashes, NUL bytes, dot segments, and empty segments.
 *   2. After joining under the destination directory the *resolved* path
 *      (with symlinks followed) must still live under the *resolved*
 *      destination directory.
 *
 * Step 2 is the symlink-escape defense: a malicious or otherwise hostile
 * filesystem could plant a symlink inside `dest_dir` that points outside,
 * and a structural check alone would not catch it. We compare resolved
 * absolute paths to neutralize that.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { OctomilError } from "../types.js";

/** Reject relative paths that we should never write to disk.
 *
 * Mirrors Python `_validate_relative_path`. The empty-string case is
 * also rejected here because callers reach this validator from
 * artifact-level descriptors where `[""]` would otherwise collapse to
 * the destination directory itself and trigger an
 * IsADirectoryError-equivalent on write.
 */
export function validateRelativePath(relativePath: string): string {
  if (relativePath === "") {
    throw new OctomilError(
      "INVALID_INPUT",
      "Required file path must not be empty.",
    );
  }
  if (relativePath.includes("\u0000")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path contains a NUL byte: ${JSON.stringify(relativePath)}`,
    );
  }
  if (relativePath.includes("\\")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path uses backslashes: ${JSON.stringify(relativePath)}. ` +
        `Artifacts must be addressed with forward-slash POSIX paths.`,
    );
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new OctomilError(
        "INVALID_INPUT",
        `Required file path must not contain '.', '..', or empty segments: ${JSON.stringify(relativePath)}`,
      );
    }
  }
  if (relativePath.startsWith("/")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path must be relative, got: ${JSON.stringify(relativePath)}`,
    );
  }
  return relativePath;
}

/** Synchronous safe-join used by the validator + downloader hot path.
 *
 * Calls `validateRelativePath` then verifies the literal joined path
 * still resolves under `destDir` after normalization. Symlink-escape
 * containment is enforced asynchronously by `safeJoinUnder`; this
 * variant is for cases where we don't yet know whether the destination
 * even exists on disk (e.g., pre-download path computation) and still
 * want a sync, structural guard.
 */
export function safeJoinUnderSync(destDir: string, relativePath: string): string {
  const safe = validateRelativePath(relativePath);
  const baseAbs = path.resolve(destDir);
  const candidate = path.resolve(baseAbs, safe);
  // Containment via prefix-match on normalized absolute paths.
  // path.resolve collapses `..` and `.`; combined with the structural
  // checks above this rejects every traversal case the validator
  // already caught, plus any future bug-class where a benign-looking
  // input becomes traversal after normalization.
  const baseWithSep = baseAbs.endsWith(path.sep) ? baseAbs : baseAbs + path.sep;
  if (candidate !== baseAbs && !candidate.startsWith(baseWithSep)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path resolves outside the artifact directory: ` +
        `${JSON.stringify(relativePath)} -> ${candidate}`,
    );
  }
  return candidate;
}

/** Async safe-join with full symlink-escape containment.
 *
 * Use this whenever the destination directory exists on disk and the
 * caller is about to materialize bytes into it. We resolve symlinks on
 * both the base and the candidate so an attacker-controlled symlink
 * inside `destDir` cannot escape the artifact root. Mirrors Python
 * `_safe_join` semantics in materialization.py.
 */
export async function safeJoinUnder(
  destDir: string,
  relativePath: string,
): Promise<string> {
  // Structural rejection first — catches traversal/dot/empty/nul cases
  // before we ever touch the filesystem.
  const safe = validateRelativePath(relativePath);
  const baseResolved = await fsp.realpath(destDir);
  // The candidate may not exist yet; resolve as much of its path as
  // possible (every existing ancestor is followed through symlinks)
  // then re-attach the unresolved tail.
  const candidate = path.resolve(baseResolved, safe);
  const candidateResolved = await resolveExistingAncestor(candidate);
  const baseWithSep = baseResolved.endsWith(path.sep)
    ? baseResolved
    : baseResolved + path.sep;
  if (
    candidateResolved !== baseResolved &&
    !candidateResolved.startsWith(baseWithSep)
  ) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path resolves outside the artifact directory: ` +
        `${JSON.stringify(relativePath)} -> ${candidateResolved}`,
    );
  }
  return candidate;
}

/** Resolve symlinks on the longest existing prefix of `target`,
 * preserving any unresolved tail. This is the JS equivalent of
 * Python's `Path.resolve(strict=False)` semantics for our purposes:
 * if a symlink lives inside the existing-prefix portion of the path,
 * it WILL be followed, so we can compare against the destination's
 * realpath and detect symlink escapes.
 */
async function resolveExistingAncestor(target: string): Promise<string> {
  const segments = target.split(path.sep).filter((s) => s.length > 0);
  const isAbsolute = path.isAbsolute(target);
  let current = isAbsolute ? path.parse(target).root : "";
  let unresolvedStart = 0;
  for (let i = 0; i < segments.length; i++) {
    const next = path.join(current, segments[i]!);
    try {
      // realpath follows symlinks at every level. If the next prefix
      // exists, we adopt the realpath form; if not, we stop and let
      // the rest of the path stay literal.
      // eslint-disable-next-line no-await-in-loop
      const real = await fsp.realpath(next);
      current = real;
      unresolvedStart = i + 1;
    } catch {
      break;
    }
  }
  const tail = segments.slice(unresolvedStart);
  if (tail.length === 0) return current;
  return path.join(current, ...tail);
}
