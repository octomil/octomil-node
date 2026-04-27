/**
 * Shared filesystem-key helper for planner-supplied identifiers.
 *
 * Port of Python ``octomil/runtime/lifecycle/_fs_key.py``. The
 * PrepareManager (artifact dir layout) and FileLock (per-artifact
 * lock files) must agree on the key shape so two layers of the
 * prepare-lifecycle pipeline cannot disagree about safety. This module
 * is the one place that decides.
 *
 * Key requirements (mirrored from Python):
 *
 *   - **Bounded byte length.** ``NAME_MAX`` on every common
 *     filesystem (ext4, APFS, NTFS) is 255 *bytes*, not 255
 *     characters. A naive char-count cap admits filenames many times
 *     over NAME_MAX once non-ASCII is involved (one emoji can be up
 *     to 4 bytes UTF-8). The visible portion is therefore capped at
 *     ``maxVisibleChars`` *characters* of pure ASCII output (the
 *     sanitizer replaces every non-ASCII byte with ``_`` first).
 *   - **Windows-safe.** Windows reserves ``< > : " / \ | ? *`` in
 *     filenames; the regex strips them all (along with everything
 *     non-ASCII).
 *   - **Stable mapping.** Same input → same output, so cache hits
 *     are reproducible across processes and across SDKs (Python /
 *     Node must pick the same key for the same artifact id).
 *   - **Disambiguating.** Distinct planner ids that sanitize to the
 *     same visible name still get distinct keys via a SHA-256 suffix
 *     taken over the *original* (unmodified) input.
 *
 * @module prepare/fs-key
 */

import { createHash } from "node:crypto";

/** ASCII allow-list. Anything outside this set — including all
 * non-ASCII characters and Windows-reserved punctuation — is
 * replaced with ``_``. Mirror of Python's
 * ``_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")``. */
const SAFE_CHARS = /[^A-Za-z0-9._-]/g;

/** Visible-portion cap. The full key is ``<visible>-<12-char hash>``;
 * 96 + 1 + 12 = 109-byte ASCII payload, well under NAME_MAX (255
 * bytes) even with the consumer's own suffix (e.g. ``.lock``). */
export const DEFAULT_MAX_VISIBLE_CHARS = 96;

/** Strip leading and trailing ``_`` and ``.`` runs from a sanitized
 * key. Used twice — once after substitution, once after truncation —
 * to mirror Python's ``.strip("_.")`` semantics exactly. */
function stripLeadingTrailingUnderscoresDots(value: string): string {
  return value.replace(/^[_.]+/, "").replace(/[_.]+$/, "");
}

/**
 * Return a NAME_MAX-safe, Windows-safe, deterministic key for
 * ``name``.
 *
 * The result is always pure ASCII, ``result.length <= maxVisibleChars
 * + 13``, and stable across processes. Empty / dot-only inputs
 * collapse to ``"id"`` plus the hash suffix so the consumer always
 * has at least a 14-character (1 + 1 + 12) component to work with.
 *
 * Throws ``RangeError`` only when ``name`` contains a NUL byte —
 * callers that already check this can ignore the contract. Every
 * other structurally-invalid input (absolute paths, traversal,
 * Windows reserved chars, non-UTF-8 surrogates) sanitizes safely.
 *
 * @param name - The planner-supplied identifier to convert.
 * @param maxVisibleChars - Cap on the readable portion (default 96).
 * @returns A pure-ASCII key suitable for use as a path component.
 */
export function safeFilesystemKey(
  name: string,
  maxVisibleChars: number = DEFAULT_MAX_VISIBLE_CHARS,
): string {
  if (name.includes("\u0000")) {
    throw new RangeError("filesystem key must not contain NUL bytes");
  }

  let sanitized = stripLeadingTrailingUnderscoresDots(name.replace(SAFE_CHARS, "_"));
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    sanitized = "id";
  }
  if (sanitized.length > maxVisibleChars) {
    sanitized = stripLeadingTrailingUnderscoresDots(sanitized.slice(0, maxVisibleChars));
    if (!sanitized) {
      sanitized = "id";
    }
  }
  const digestPrefix = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 12);
  return `${sanitized}-${digestPrefix}`;
}
