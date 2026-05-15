#!/usr/bin/env node
/**
 * Fetch a dev-only liboctomil-runtime release from the private
 * octomil/octomil-runtime repo and unpack it into the local cache.
 *
 * This is the supported path for local + CI dev environments that need
 * the dylib without a source build. Production / customer distribution
 * will eventually use signed-and-notarized binaries; this script is for
 * the v0.0.x dev range only.
 *
 * Mirrors octomil-python/scripts/fetch_runtime_dev.py in Node idioms.
 *
 * Resolution (v0.1.5+ manifest-driven path):
 *   1. Download MANIFEST.json from the release.
 *   2. Resolve the asset filename for (arch, flavor) from platforms[arch][flavor].
 *   3. Download that asset + octomil-runtime-headers-<ver>.tar.gz + SHA256SUMS.
 *   4. Verify sha256, safe-extract, write sentinel.
 *
 * Fallback (v0.1.4 legacy — no MANIFEST.json):
 *   - Uses the legacy octomil-runtime-<arch>-<ver>.tar.gz shape.
 *
 * Auth:
 *   - Reads GH_TOKEN / GITHUB_TOKEN / OCTOMIL_RUNTIME_TOKEN for
 *     private-repo auth. Falls back to `gh auth token` if available.
 *
 * Extraction target: ~/.cache/octomil-runtime/<version>/<flavor>/{lib,include}
 * Sentinel: <version>/<flavor>/lib/.extracted-ok  (loader.ts:45 CACHE_SENTINEL)
 *
 * Legacy layout (pre v0.1.5, no flavor subdir): <version>/{lib,include}
 * The fetcher never writes legacy layout; loader.ts accepts it as chat-only fallback.
 *
 * CLI:
 *   node scripts/fetch_runtime_dev.mjs [--version vX.Y.Z] [--flavor chat|stt]
 *                                       [--cache-root <path>] [--force]
 *   pnpm fetch:runtime
 *
 * Exit codes: 0 = success, 1 = runtime error, 2 = bad arguments.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync as _nativeSpawnSync } from "node:child_process";
import * as https from "node:https";
import * as http from "node:http";

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO = "octomil/octomil-runtime";

/**
 * DEFAULT_VERSION: keep in lockstep with
 * octomil-python/scripts/fetch_runtime_dev.py:42
 * v0.1.10: pinned to the latest runtime release (see octomil-runtime release notes).
 * Manifest-driven asset resolution (MANIFEST.json present since v0.1.5).
 */
const DEFAULT_VERSION = "v0.1.10";

/**
 * DEFAULT_FLAVOR: flavor to fetch when --flavor is not specified.
 * "chat" covers the general-purpose inference capability (text generation,
 * embeddings). "stt" is Whisper-based speech-to-text.
 */
const DEFAULT_FLAVOR = "chat";

/**
 * SUPPORTED_FLAVORS: canonical flavor identifiers shipped in MANIFEST.json.
 */
const SUPPORTED_FLAVORS = ["chat", "stt"];

/**
 * CACHE_SENTINEL: filename the loader checks inside <version>/lib/.
 * Must match loader.ts:45  const CACHE_SENTINEL = ".extracted-ok"
 */
const CACHE_SENTINEL = ".extracted-ok";

/**
 * CACHE_LIB_NAMES: dylib basenames the loader searches for.
 * Must match loader.ts:46-49
 */
const CACHE_LIB_NAMES = [
  "liboctomil-runtime.dylib",
  "liboctomil-runtime.so",
];

/**
 * ENV_RUNTIME_CACHE_DIR: env var the loader reads for the cache root.
 * Must match loader.ts:9  export const ENV_RUNTIME_CACHE_DIR = "OCTOMIL_RUNTIME_CACHE_DIR"
 */
const ENV_RUNTIME_CACHE_DIR = "OCTOMIL_RUNTIME_CACHE_DIR";

const DEFAULT_CACHE_ROOT = process.env[ENV_RUNTIME_CACHE_DIR]
  ?? path.join(os.homedir(), ".cache", "octomil-runtime");

// ── Test hooks ────────────────────────────────────────────────────────────────

/**
 * _testHooks: mutable object that tests can override to inject fake
 * spawnSync behaviour without needing to mock the non-configurable
 * node:child_process named export.
 *
 * Production code calls _spawnSync() which reads from this object.
 * Tests that need to control tar listing output replace .spawnSync.
 */
export const _testHooks = {
  /** @type {typeof import("node:child_process").spawnSync} */
  spawnSync: _nativeSpawnSync,
};

function _spawnSync(cmd, args, opts) {
  return _testHooks.spawnSync(cmd, args, opts);
}

// ── Error class ───────────────────────────────────────────────────────────────

export class FetchRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = "FetchRuntimeError";
  }
}

// ── Token resolution ──────────────────────────────────────────────────────────

/**
 * Try GH_TOKEN, GITHUB_TOKEN, OCTOMIL_RUNTIME_TOKEN in order, then
 * fall back to `gh auth token`. Returns null if nothing is available.
 * Mirrors fetch_runtime_dev.py:_gh_token().
 */
export function getGhToken() {
  for (const env of ["GH_TOKEN", "GITHUB_TOKEN", "OCTOMIL_RUNTIME_TOKEN"]) {
    if (process.env[env]) return process.env[env].trim();
  }
  try {
    const result = _spawnSync("gh", ["auth", "token"], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (result.status === 0 && result.stdout && result.stdout.trim()) {
      return result.stdout.trim();
    }
  } catch {
    // gh not found or failed — fall through
  }
  return null;
}

// ── Platform key ──────────────────────────────────────────────────────────────

/**
 * Return the { arch, flavor } pair for the current host platform.
 * "arch" matches the key format used in MANIFEST.json "platforms":
 *   darwin-arm64, linux-x86_64, android-arm64
 *
 * Mirrors fetch_runtime_dev.py:_platform_key().
 */
export function platformKey(flavor) {
  const plat = process.platform;
  const arch = process.arch;

  let manifestArch;
  if (plat === "darwin" && arch === "arm64") {
    manifestArch = "darwin-arm64";
  } else if (plat === "linux" && arch === "x64") {
    manifestArch = "linux-x86_64";
  } else if (plat === "linux" && arch === "arm64") {
    // android-arm64 is the only arm64-linux target; standard Linux arm64
    // is not shipped. Treat as unsupported until a linux-arm64 artifact
    // exists in the manifest.
    throw new FetchRuntimeError(
      `error: no dev artifact for linux/arm64 at this release.\n` +
      `See octomil-runtime release notes for supported platforms.`
    );
  } else {
    throw new FetchRuntimeError(
      `error: no dev artifact for ${plat}/${arch}.\n` +
      `Supported platforms: darwin-arm64, linux-x86_64. ` +
      `See octomil-runtime release notes.`
    );
  }

  return { arch: manifestArch, flavor };
}

// ── Platform asset name (legacy fallback) ─────────────────────────────────────

/**
 * Return the tarball basename for the current platform using the legacy
 * v0.1.4 naming shape: octomil-runtime-<arch>-<ver>.tar.gz
 *
 * Only invoked when MANIFEST.json is absent from the release.
 * Mirrors fetch_runtime_dev.py:_platform_asset_name().
 */
export function platformAssetName(version) {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "darwin" && arch === "arm64") {
    return `octomil-runtime-darwin-arm64-${version}.tar.gz`;
  }
  if (plat === "linux" && arch === "x64") {
    throw new FetchRuntimeError(
      `error: no dev artifact for linux/x86_64 at ${version}.\n` +
      `v0.0.x ships macOS arm64 only. See octomil-runtime release notes.`
    );
  }
  if (plat === "linux" && arch === "arm64") {
    throw new FetchRuntimeError(
      `error: no dev artifact for linux/arm64 at ${version}.\n` +
      `v0.0.x ships macOS arm64 only. See octomil-runtime release notes.`
    );
  }
  throw new FetchRuntimeError(
    `error: no dev artifact for ${plat}/${arch} at ${version}.\n` +
    `v0.0.x ships macOS arm64 only. See octomil-runtime release notes.`
  );
}

// ── GitHub API ────────────────────────────────────────────────────────────────

/**
 * GET the GitHub Releases API for a tag and return a map of
 * { assetName → assetObject }. Mirrors fetch_runtime_dev.py:_release_assets_via_api().
 */
export async function releaseAssetsViaApi(version, token) {
  const url = `https://api.github.com/repos/${REPO}/releases/tags/${version}`;
  const json = await jsonGet(url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "octomil-node/fetch_runtime_dev.mjs",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  const assets = json.assets ?? [];
  const map = {};
  for (const a of assets) {
    map[a.name] = a;
  }
  return map;
}

// ── MANIFEST.json ─────────────────────────────────────────────────────────────

/**
 * Attempt to download and parse MANIFEST.json from the release asset list.
 * Returns the parsed manifest object, or null if MANIFEST.json is not present
 * (v0.1.4 and earlier releases that predate the manifest contract).
 *
 * MANIFEST.json schema (from release.yml manifest job):
 * {
 *   "version": "vX.Y.Z",
 *   "abi": { "major": N, "minor": N, "patch": N },
 *   "platforms": {
 *     "<arch>": { "<flavor>": "<asset-filename.tar.gz>" }
 *   },
 *   "headers": "octomil-runtime-headers-<ver>.tar.gz" | null,
 *   "xcframework": { "chat": "...", "stt": "..." } | null
 * }
 *
 * Mirrors fetch_runtime_dev.py:_load_manifest().
 *
 * @param {Record<string, object>} assets - asset map from releaseAssetsViaApi
 * @param {string} workDir - scratch directory for the download
 * @param {string} token - GitHub auth token
 * @returns {Promise<object|null>}
 */
export async function loadManifest(assets, workDir, token) {
  const MANIFEST_NAME = "MANIFEST.json";
  if (!(MANIFEST_NAME in assets)) {
    return null;
  }

  const destPath = path.join(workDir, MANIFEST_NAME);
  await downloadAsset(assets[MANIFEST_NAME].url, destPath, token);

  let parsed;
  try {
    const raw = await fs.readFile(destPath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new FetchRuntimeError(
      `error: failed to parse MANIFEST.json for this release: ${e.message}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new FetchRuntimeError("error: MANIFEST.json is not a JSON object");
  }
  if (typeof parsed.platforms !== "object" || parsed.platforms === null) {
    throw new FetchRuntimeError(
      "error: MANIFEST.json missing or invalid 'platforms' field"
    );
  }

  return parsed;
}

/**
 * Resolve the asset filename for (arch, flavor) from a parsed manifest.
 * Throws FetchRuntimeError with available flavors listed when the requested
 * flavor is absent for this platform.
 *
 * @param {object} manifest - parsed MANIFEST.json
 * @param {string} arch     - e.g. "darwin-arm64"
 * @param {string} flavor   - e.g. "chat" | "stt"
 * @returns {string} asset filename, e.g. "liboctomil-runtime-v0.1.5-chat-darwin-arm64.tar.gz"
 */
export function resolveManifestAsset(manifest, arch, flavor) {
  const platformEntry = manifest.platforms[arch];
  if (!platformEntry || typeof platformEntry !== "object") {
    const available = Object.keys(manifest.platforms);
    throw new FetchRuntimeError(
      `error: MANIFEST.json has no entry for platform ${JSON.stringify(arch)}.\n` +
      `Available platforms: ${available.join(", ")}`
    );
  }

  const assetName = platformEntry[flavor];
  if (!assetName) {
    const available = Object.keys(platformEntry);
    throw new FetchRuntimeError(
      `error: MANIFEST.json has no ${JSON.stringify(flavor)} artifact for ${arch}.\n` +
      `Available flavors for ${arch}: ${available.join(", ")}`
    );
  }

  return assetName;
}

// ── Download ──────────────────────────────────────────────────────────────────

/**
 * Stream a private GitHub asset to disk using the asset API URL
 * (not browser_download_url — this is the authenticated path for
 * private repos). Mirrors fetch_runtime_dev.py:_download().
 */
export async function downloadAsset(url, destPath, token) {
  process.stderr.write(`  download ${url}\n`);
  await httpGetFile(url, destPath, {
    Authorization: `Bearer ${token}`,
    Accept: "application/octet-stream",
    "User-Agent": "octomil-node/fetch_runtime_dev.mjs",
  });
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────

/**
 * Hex SHA-256 digest of a file. Mirrors fetch_runtime_dev.py:_sha256().
 */
export async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Move the contents of the bin tarball's top-level directory up one
 * level into ``targetDir``. Mirrors octomil-python (#597) fix.
 *
 * release.yml's Stage archive step wraps each platform tarball in a
 * top-level directory matching the archive basename
 * (``liboctomil-runtime-<ver>-<flavor>-<arch>/lib/...``). The loader
 * expects ``<target>/lib/...``, so flatten one level after extraction.
 * No-op when the wrapper dir is absent (legacy v0.1.4 tarballs).
 */
export async function flattenArchiveTopDir(targetDir, binName) {
  const archiveBasename = binName.endsWith(".tar.gz")
    ? binName.slice(0, -".tar.gz".length)
    : binName;
  const top = path.join(targetDir, archiveBasename);
  let stat;
  try {
    stat = await fs.stat(top);
  } catch {
    return;
  }
  if (!stat.isDirectory()) return;

  const entries = await fs.readdir(top);
  for (const name of entries) {
    const src = path.join(top, name);
    const dst = path.join(targetDir, name);
    let dstExists = false;
    try {
      await fs.access(dst);
      dstExists = true;
    } catch {
      // dst does not exist; safe to rename outright
    }
    if (dstExists) {
      const dstStat = await fs.stat(dst);
      const srcStat = await fs.stat(src);
      if (dstStat.isDirectory() && srcStat.isDirectory()) {
        // Merge dirs (headers tarball may have populated include/ already).
        await mergeDirRecursive(src, dst);
        await fs.rm(src, { recursive: true, force: true });
      } else {
        throw new FetchRuntimeError(
          `error: flattening ${archiveBasename}/ would overwrite existing ${dst}`
        );
      }
    } else {
      await fs.rename(src, dst);
    }
  }
  await fs.rmdir(top);
}

async function mergeDirRecursive(srcDir, dstDir) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      await fs.mkdir(dst, { recursive: true });
      await mergeDirRecursive(src, dst);
    } else if (ent.isSymbolicLink()) {
      const target = await fs.readlink(src);
      try {
        await fs.unlink(dst);
      } catch {
        // ignore
      }
      await fs.symlink(target, dst);
    } else {
      await fs.copyFile(src, dst);
    }
  }
}

/**
 * Parse SHA256SUMS and verify a single file.
 * Format: one `<hex>  <name>` per line.
 * Mirrors fetch_runtime_dev.py:_verify_sha256().
 */
export async function verifySha256(filePath, sumsPath) {
  const raw = await fs.readFile(sumsPath, "utf-8");
  const expected = {};
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Format: "<hex>  <filename>" (two spaces, per sha256sum convention)
    // We split on the first whitespace run to be permissive.
    const match = line.match(/^([0-9a-fA-F]{64})\s+(.+)$/);
    if (match) {
      // `shasum -a 256 ./*.tar.gz` (used by release.yml's publish-release
      // aggregation) writes each line as `<hash>  ./<name>`. We look up
      // entries by bare basename, so strip the leading `./` here.
      // Matches the octomil-python (#596) and octomil-android (#262) fix.
      let filename = match[2].trim();
      if (filename.startsWith("./")) {
        filename = filename.slice(2);
      }
      expected[filename] = match[1].toLowerCase();
    }
  }
  const basename = path.basename(filePath);
  if (!(basename in expected)) {
    throw new FetchRuntimeError(`error: ${basename} not listed in SHA256SUMS`);
  }
  const got = await sha256File(filePath);
  if (got !== expected[basename]) {
    throw new FetchRuntimeError(
      `error: sha256 mismatch for ${basename}\n` +
      `  expected: ${expected[basename]}\n` +
      `  got:      ${got}\n` +
      `Refuse to extract a corrupt or tampered artifact.`
    );
  }
}

// ── AppleDouble filter ────────────────────────────────────────────────────────

/**
 * Returns true for macOS AppleDouble xattr entries (._*) that appear
 * when tarballs are built from a working tree with xattrs.
 * Mirrors fetch_runtime_dev.py:_is_appledouble().
 */
export function isAppleDouble(name) {
  const base = name.split("/").pop() ?? name;
  return base.startsWith("._");
}

// ── Safe extraction ───────────────────────────────────────────────────────────

/**
 * Extract tarball into targetDir with the same safety properties as
 * Python's filter="data" (which we can't use on older Python).
 *
 * Refuses:
 *   - path-traversal or absolute paths
 *   - symlinks (any)
 *   - hardlinks (any)
 *   - character / block / fifo device entries
 *   - any resolved path that escapes targetDir
 *
 * Filters out macOS AppleDouble (._*) metadata.
 *
 * Strategy:
 *   1. Run `tar -tvf` to get a verbose listing with permission bits.
 *   2. Validate each entry: check perm first-char for entry type (l/h/c/b/p),
 *      check name for traversal/absolute/confinement.
 *   3. Run `tar -xf --exclude='._*'` to extract.
 *   4. Post-extraction confinement pass using `tar -tf` (plain listing).
 *
 * Mirrors fetch_runtime_dev.py:_safe_extract().
 */
export async function safeExtract(tarballPath, targetDir) {
  // Use realpath to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS).
  // Fall back to path.resolve if realpath fails (e.g. dir not yet created).
  let realTarget;
  try {
    realTarget = await fs.realpath(targetDir);
  } catch {
    realTarget = path.resolve(targetDir);
  }

  // ── listing pass — verbose, for type detection ────────────────────────────
  const listResult = _spawnSync(
    "tar",
    ["-tvf", tarballPath],
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (listResult.status !== 0) {
    throw new FetchRuntimeError(
      `error: tar listing failed for ${path.basename(tarballPath)}: ${listResult.stderr ?? ""}`
    );
  }

  const lines = (listResult.stdout ?? "").split("\n");
  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    // The first character of the permissions field identifies the entry type:
    //   '-' = regular file, 'd' = directory
    //   'l' = symlink, 'h' = hardlink (BSD), 'L' = hardlink (some formats)
    //   'c' = char device, 'b' = block device, 'p' = FIFO
    const firstChar = rawLine.trimStart()[0] ?? "-";

    // Extract the entry name. BSD tar (macOS) verbose format:
    //   <perms> <uid> <user> <group> <size> <Mon> <DD> <HH:MM> <name>
    //   e.g.: drwxr-xr-x  0 user wheel  0 May 13 22:20 lib/
    // The name is everything after the timestamp (index 8 in split-on-spaces).
    // GNU tar verbose:
    //   <perms> <user/group> <size> <YYYY-MM-DD HH:MM> <name>
    // We handle both by extracting the last field(s) after the timestamp.
    const entryName = parseTarVerboseName(rawLine);
    if (!entryName) continue;

    // Filter AppleDouble entries silently.
    if (isAppleDouble(entryName)) continue;

    // Symlinks/hardlinks: allowed if the resolved link target stays
    // inside targetDir. macOS dylib chains (liboctomil-runtime.dylib ->
    // .0.dylib -> .0.1.10.dylib) and Linux SONAME chains rely on
    // intra-archive symlinks — refusing them blocks v0.1.10 darwin
    // consumption entirely. Absolute targets and escaping targets
    // remain refused. Matches the octomil-python (#597) fix.
    if (firstChar === "l" || firstChar === "L" || firstChar === "h") {
      const linkTarget = parseTarLinkTarget(rawLine);
      if (linkTarget === null) {
        throw new FetchRuntimeError(
          `error: link entry ${JSON.stringify(entryName)} has no parseable target in tar -tvf output`
        );
      }
      if (linkTarget.startsWith("/")) {
        throw new FetchRuntimeError(
          `error: refusing to extract link entry ${JSON.stringify(entryName)} ` +
          `with absolute target ${JSON.stringify(linkTarget)}`
        );
      }
      // Resolve relative to the symlink's own directory for symlinks;
      // relative to archive root for hardlinks.
      const linkOrigin =
        firstChar === "h"
          ? realTarget
          : path.resolve(realTarget, path.dirname(entryName));
      const linkResolved = path.resolve(linkOrigin, linkTarget);
      const linkInside =
        linkResolved === realTarget ||
        linkResolved.startsWith(realTarget + path.sep);
      if (!linkInside) {
        throw new FetchRuntimeError(
          `error: link entry ${JSON.stringify(entryName)} target ` +
          `${JSON.stringify(linkTarget)} would escape ${targetDir} on resolution`
        );
      }
    }

    // Reject device entries.
    if (firstChar === "c" || firstChar === "b" || firstChar === "p") {
      throw new FetchRuntimeError(
        `error: refusing to extract device entry ${JSON.stringify(entryName)} ` +
        `from ${path.basename(tarballPath)}`
      );
    }

    // Reject absolute paths.
    if (entryName.startsWith("/")) {
      throw new FetchRuntimeError(
        `error: refusing to extract absolute-path tar entry ${JSON.stringify(entryName)} ` +
        `from ${path.basename(tarballPath)}`
      );
    }

    // Reject path traversal.
    if (entryName.split("/").some((seg) => seg === "..")) {
      throw new FetchRuntimeError(
        `error: refusing to extract path-traversal tar entry ${JSON.stringify(entryName)} ` +
        `from ${path.basename(tarballPath)}`
      );
    }

    // Final path-confinement check. Use realTarget (symlink-resolved) as the
    // base so that macOS /var → /private/var resolution is consistent.
    const resolved = path.resolve(realTarget, entryName);
    const isInside = resolved === realTarget || resolved.startsWith(realTarget + path.sep);
    if (!isInside) {
      throw new FetchRuntimeError(
        `error: tar entry ${JSON.stringify(entryName)} would escape ${targetDir} on resolution`
      );
    }
  }

  // ── extraction pass ────────────────────────────────────────────────────────
  const extractResult = _spawnSync(
    "tar",
    ["-xf", tarballPath, "-C", targetDir, "--exclude=._*"],
    { encoding: "utf-8" },
  );
  if (extractResult.status !== 0) {
    throw new FetchRuntimeError(
      `error: tar extraction failed for ${path.basename(tarballPath)}: ${extractResult.stderr ?? ""}`
    );
  }

  // ── post-extraction confinement (plain listing) ───────────────────────────
  const afterList = _spawnSync(
    "tar",
    ["-tf", tarballPath],
    { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (afterList.status === 0 && afterList.stdout) {
    for (const rawName of afterList.stdout.split("\n")) {
      const name = rawName.trim();
      if (!name || isAppleDouble(name)) continue;
      const resolved = path.resolve(realTarget, name);
      const isInside = resolved === realTarget || resolved.startsWith(realTarget + path.sep);
      if (!isInside) {
        try {
          await fs.rm(resolved, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
        throw new FetchRuntimeError(
          `error: post-extraction confinement failure: ${JSON.stringify(name)} escaped ${targetDir}`
        );
      }
    }
  }
}

// ── tar verbose listing name extractor ───────────────────────────────────────

/**
 * Extract the entry name from a `tar -tv` verbose-listing line.
 *
 * BSD tar (macOS) format (9+ tokens):
 *   <perms> <uid> <user> <group> <size> <Mon> <DD> <HH:MM|YYYY> <name...>
 *   e.g.: drwxr-xr-x  0 seanb  wheel  0 May 13 22:20 lib/
 *
 * GNU tar format (6+ tokens):
 *   <perms> <user/group> <size> <YYYY-MM-DD> <HH:MM> <name...>
 *   e.g.: drwxr-xr-x user/group 0 2024-01-01 00:00 lib/
 *
 * Strategy: detect format by checking whether token[3] looks like a
 * month name (BSD) or token[1] contains '/' (GNU). Then slice accordingly.
 *
 * Returns null when the line cannot be parsed.
 */
export function parseTarVerboseName(line) {
  const trimmed = line.trimStart();
  const parts = trimmed.split(/\s+/);

  // BSD tar: tokens[3] is group name (no '/'), tokens[5] is a month abbreviation
  // GNU tar: tokens[1] contains '/' (user/group)
  // We detect BSD by checking if tokens[1] does NOT contain '/' and
  // there are at least 9 tokens.
  if (parts.length >= 9 && !parts[1].includes("/")) {
    // BSD: perms(0) uid(1) user(2) group(3) size(4) month(5) day(6) time(7) name(8+)
    let name = parts.slice(8).join(" ");
    name = stripLinkSuffix(name);
    return name || null;
  }

  // GNU tar: perms(0) user/group(1) size(2) date(3) time(4) name(5+)
  if (parts.length >= 6) {
    let name = parts.slice(5).join(" ");
    name = stripLinkSuffix(name);
    return name || null;
  }

  return null;
}

function stripLinkSuffix(name) {
  // Strip symlink target: "name -> target"
  const arrowIdx = name.indexOf(" -> ");
  if (arrowIdx !== -1) return name.slice(0, arrowIdx);
  // Strip hardlink marker: "name link to target"
  const linkIdx = name.indexOf(" link to ");
  if (linkIdx !== -1) return name.slice(0, linkIdx);
  return name;
}

/**
 * Extract the link target from a `tar -tvf` verbose line. Returns the
 * raw target path (still relative or absolute as written in the
 * archive), or null when no link suffix is present.
 *
 * Examples:
 *   "lrwxr-xr-x ... lib/liboctomil-runtime.0.dylib -> liboctomil-runtime.0.1.10.dylib"
 *     → "liboctomil-runtime.0.1.10.dylib"
 *   "hrwxr-xr-x ... lib/foo link to lib/bar" → "lib/bar"
 */
export function parseTarLinkTarget(line) {
  const arrowIdx = line.indexOf(" -> ");
  if (arrowIdx !== -1) return line.slice(arrowIdx + 4).trim() || null;
  const linkIdx = line.indexOf(" link to ");
  if (linkIdx !== -1) return line.slice(linkIdx + 9).trim() || null;
  return null;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function jsonGet(url, headers) {
  const body = await httpGetBody(url, headers);
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new FetchRuntimeError(`error: failed to parse JSON from ${url}: ${e}`);
  }
}

async function httpGetBody(url, headers, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    makeRequest(url, headers, maxRedirects, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    }, reject);
  });
}

async function httpGetFile(url, destPath, headers, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    makeRequest(url, headers, maxRedirects, (res) => {
      const out = createWriteStream(destPath);
      res.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      res.on("error", reject);
    }, reject);
  });
}

function makeRequest(url, headers, maxRedirects, onResponse, onError) {
  const mod = url.startsWith("https:") ? https : http;
  const req = mod.get(url, { headers }, (res) => {
    const { statusCode, headers: resHeaders } = res;
    if (statusCode >= 300 && statusCode < 400 && resHeaders.location) {
      if (maxRedirects <= 0) {
        onError(new FetchRuntimeError(`error: too many redirects for ${url}`));
        return;
      }
      res.resume();
      makeRequest(resHeaders.location, headers, maxRedirects - 1, onResponse, onError);
      return;
    }
    if (statusCode < 200 || statusCode >= 300) {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8", 0, 500);
        onError(new FetchRuntimeError(
          `HTTP ${statusCode} fetching ${url}\nResponse: ${body}\n` +
          `If this is a 404 or 401, confirm your token has read access ` +
          `to the private octomil/octomil-runtime repo.`
        ));
      });
      return;
    }
    onResponse(res);
  });
  req.on("error", onError);
}

// ── CLI arg parser ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    version: DEFAULT_VERSION,
    flavor: DEFAULT_FLAVOR,
    cacheRoot: DEFAULT_CACHE_ROOT,
    force: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--force") {
      result.force = true;
    } else if (arg === "--version") {
      if (i + 1 >= args.length) {
        process.stderr.write("error: --version requires an argument\n");
        process.exit(2);
      }
      result.version = args[++i];
    } else if (arg.startsWith("--version=")) {
      result.version = arg.slice("--version=".length);
    } else if (arg === "--flavor") {
      if (i + 1 >= args.length) {
        process.stderr.write("error: --flavor requires an argument\n");
        process.exit(2);
      }
      result.flavor = args[++i];
    } else if (arg.startsWith("--flavor=")) {
      result.flavor = arg.slice("--flavor=".length);
    } else if (arg === "--cache-root") {
      if (i + 1 >= args.length) {
        process.stderr.write("error: --cache-root requires an argument\n");
        process.exit(2);
      }
      result.cacheRoot = args[++i];
    } else if (arg.startsWith("--cache-root=")) {
      result.cacheRoot = arg.slice("--cache-root=".length);
    } else {
      process.stderr.write(`error: unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }

  // Validate flavor.
  if (!SUPPORTED_FLAVORS.includes(result.flavor)) {
    process.stderr.write(
      `error: unknown flavor ${JSON.stringify(result.flavor)}. ` +
      `Valid values: ${SUPPORTED_FLAVORS.join(", ")}\n`
    );
    process.exit(2);
  }

  return result;
}

function printHelp() {
  process.stdout.write(
    `Usage: node scripts/fetch_runtime_dev.mjs [OPTIONS]\n` +
    `\n` +
    `Fetch a dev-only liboctomil-runtime release from octomil/octomil-runtime\n` +
    `and unpack it into the local cache for use by the Node SDK loader.\n` +
    `\n` +
    `Options:\n` +
    `  --version <tag>        Release tag to fetch (default: ${DEFAULT_VERSION})\n` +
    `  --flavor {chat,stt}    Runtime flavor to fetch (default: ${DEFAULT_FLAVOR})\n` +
    `                         chat: general inference + embeddings\n` +
    `                         stt:  Whisper speech-to-text\n` +
    `  --cache-root <path>    Override cache root (default: ~/.cache/octomil-runtime\n` +
    `                         or $OCTOMIL_RUNTIME_CACHE_DIR)\n` +
    `  --force                Re-download even if cache is populated\n` +
    `  -h, --help             Show this help message\n` +
    `\n` +
    `Resolution order:\n` +
    `  v0.1.5+ releases ship MANIFEST.json — asset names are resolved from it.\n` +
    `  v0.1.4 and earlier (no manifest): falls back to legacy asset name shape.\n` +
    `\n` +
    `Token resolution order:\n` +
    `  1. $GH_TOKEN\n` +
    `  2. $GITHUB_TOKEN\n` +
    `  3. $OCTOMIL_RUNTIME_TOKEN\n` +
    `  4. \`gh auth token\` (via GitHub CLI)\n` +
    `\n` +
    `After extraction the dylib is available at:\n` +
    `  <cache-root>/<version>/<flavor>/lib/liboctomil-runtime.dylib\n`
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();
    return 0;
  }

  const { version, flavor, force } = opts;
  const cacheRoot = opts.cacheRoot.replace(/^~(?=\/|$)/, os.homedir());
  // Flavor-keyed layout: <cacheRoot>/<version>/<flavor>/{lib,include}
  // Legacy layout (pre-flavor) was: <cacheRoot>/<version>/{lib,include}
  const targetDir = path.join(cacheRoot, version, flavor);
  const libDir = path.join(targetDir, "lib");
  const incDir = path.join(targetDir, "include");
  const sentinel = path.join(libDir, CACHE_SENTINEL);

  // The expected dylib name: .dylib on macOS, .so on Linux.
  const expectedDylibName = process.platform === "darwin"
    ? "liboctomil-runtime.dylib"
    : "liboctomil-runtime.so";
  const dylib = path.join(libDir, expectedDylibName);

  // Sentinel check: only skip if both the dylib and sentinel exist.
  if (!force && existsSync(dylib) && existsSync(sentinel)) {
    process.stdout.write(`already cached: ${dylib}\n`);
    return 0;
  }
  if (existsSync(dylib) && !existsSync(sentinel)) {
    process.stderr.write(`cache at ${targetDir} looks incomplete; re-fetching\n`);
  }

  const token = getGhToken();
  if (!token) {
    process.stderr.write(
      "error: no GitHub token available.\n" +
      "Set GH_TOKEN/GITHUB_TOKEN, or run `gh auth login` so this script\n" +
      "can call `gh auth token` for the private repo's release assets.\n"
    );
    process.exit(1);
  }

  process.stderr.write(`fetching octomil-runtime ${version} (${flavor}) into ${targetDir}\n`);
  await fs.mkdir(targetDir, { recursive: true });
  // Download scratch dir MUST live OUTSIDE targetDir.
  //
  // If work lived inside targetDir, a crafted archive could include
  // `lib/liboctomil-runtime.dylib -> ../_download/<asset>`, pass the
  // safeExtract symlink-target check (target IS inside targetDir),
  // and satisfy the post-extract existence probe — then break at load
  // time once we delete _download. Placing work as a sibling of
  // targetDir closes the window: any symlink target pointing into
  // the scratch dir now correctly trips the "would escape" guard.
  //
  // Per-flavor suffix lets concurrent fetches of different flavors
  // share the version dir without colliding on the same scratch dir.
  // Matches octomil-python's fetch_runtime_dev.py layout.
  const versionDir = path.dirname(targetDir);
  const work = path.join(versionDir, `_download-${flavor}`);
  await fs.mkdir(work, { recursive: true });

  try {
    // ── list release assets ──────────────────────────────────────────────────
    let assets;
    try {
      assets = await releaseAssetsViaApi(version, token);
    } catch (e) {
      if (e instanceof FetchRuntimeError) throw e;
      throw new FetchRuntimeError(
        `error listing release ${version}: ${e.message}\n` +
        `Confirm the tag exists and the token has access.`
      );
    }

    // ── manifest-driven lookup (v0.1.5+) or legacy fallback (v0.1.4) ────────
    let binName;

    const manifest = await loadManifest(assets, work, token);
    if (manifest !== null) {
      // Manifest present: resolve asset name from (arch, flavor).
      const { arch } = platformKey(flavor);
      binName = resolveManifestAsset(manifest, arch, flavor);
      process.stderr.write(`  manifest: ${arch}/${flavor} -> ${binName}\n`);
    } else {
      // No manifest: v0.1.4 legacy shape. flavor is ignored (only "chat"
      // existed before multi-flavor support).
      process.stderr.write(`  no MANIFEST.json found; using legacy asset name shape\n`);
      binName = platformAssetName(version);
    }

    const headersName = `octomil-runtime-headers-${version}.tar.gz`;
    const sumsName = "SHA256SUMS";

    for (const required of [binName, headersName, sumsName]) {
      if (!(required in assets)) {
        throw new FetchRuntimeError(`error: release ${version} missing asset ${required}`);
      }
      await downloadAsset(assets[required].url, path.join(work, required), token);
    }

    await verifySha256(path.join(work, binName), path.join(work, sumsName));
    await verifySha256(path.join(work, headersName), path.join(work, sumsName));

    // ── clean out stale lib/include before extracting ────────────────────────
    if (existsSync(libDir)) await fs.rm(libDir, { recursive: true, force: true });
    if (existsSync(incDir)) await fs.rm(incDir, { recursive: true, force: true });
    await fs.mkdir(libDir, { recursive: true });
    await fs.mkdir(incDir, { recursive: true });

    for (const tarball of [path.join(work, binName), path.join(work, headersName)]) {
      await safeExtract(tarball, targetDir);
    }

    // release.yml's Stage archive wraps each platform tarball in a
    // top-level <archive-basename>/ directory. Flatten one level so
    // <target>/lib/... lands at the canonical path the loader expects.
    // Headers tarball has no wrapper. Matches octomil-python (#597) fix.
    await flattenArchiveTopDir(targetDir, binName);

    if (!existsSync(dylib)) {
      throw new FetchRuntimeError(
        `error: extracted ${binName} but ${dylib} is not present.\n` +
        `Bundle layout may have changed.`
      );
    }

    // Write sentinel only after fully successful extraction.
    await fs.writeFile(sentinel, version + "\n", "utf-8");
  } finally {
    if (existsSync(work)) {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

  process.stdout.write(`runtime ready: ${dylib}\n`);
  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => {
    process.stderr.write(`fetch_runtime_dev.mjs error: ${err.message ?? err}\n`);
    process.exit(1);
  });
}
