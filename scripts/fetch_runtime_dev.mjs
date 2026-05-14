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
 * Resolution:
 *   - Reads GH_TOKEN / GITHUB_TOKEN / OCTOMIL_RUNTIME_TOKEN for
 *     private-repo auth. Falls back to `gh auth token` if available.
 *   - Downloads octomil-runtime-darwin-arm64-<version>.tar.gz and
 *     octomil-runtime-headers-<version>.tar.gz plus SHA256SUMS.
 *   - Verifies sha256.
 *   - Extracts to ~/.cache/octomil-runtime/<version>/lib and
 *     ~/.cache/octomil-runtime/<version>/include.
 *   - Writes a .extracted-ok sentinel into lib/ so the loader's
 *     fetchedRuntimeLibraryCandidates() treats the cache as valid.
 *
 * Once extracted, the native loader picks the dylib up automatically via
 * fetchedRuntimeLibraryCandidates(); no env var needed for the default-
 * version case. Operators that want a specific path use OCTOMIL_RUNTIME_DYLIB.
 *
 * CLI:
 *   node scripts/fetch_runtime_dev.mjs [--version vX.Y.Z] [--cache-root <path>] [--force]
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
 * v0.1.4: native embeddings.text + chat-template control-token cleanup
 * (OCT_EVENT_EMBEDDING_VECTOR + LlamaCppEmbeddingsSession + per-context pooling-type gate)
 */
const DEFAULT_VERSION = "v0.1.4";

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

// ── Platform asset name ───────────────────────────────────────────────────────

/**
 * Return the tarball basename for the current platform.
 * Mirrors fetch_runtime_dev.py:_platform_asset_name().
 * Only darwin/arm64 ships dev artifacts today.
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
      expected[match[2].trim()] = match[1].toLowerCase();
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

    // Reject symlinks.
    if (firstChar === "l" || firstChar === "L") {
      throw new FetchRuntimeError(
        `error: refusing to extract symlink entry ${JSON.stringify(entryName)} ` +
        `(symlinks not allowed in dev artifacts).`
      );
    }

    // Reject hardlinks.
    if (firstChar === "h") {
      throw new FetchRuntimeError(
        `error: refusing to extract hardlink entry ${JSON.stringify(entryName)} ` +
        `(hardlinks not allowed in dev artifacts).`
      );
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
    `  --version <tag>      Release tag to fetch (default: ${DEFAULT_VERSION})\n` +
    `  --cache-root <path>  Override cache root (default: ~/.cache/octomil-runtime\n` +
    `                       or $OCTOMIL_RUNTIME_CACHE_DIR)\n` +
    `  --force              Re-download even if cache is populated\n` +
    `  -h, --help           Show this help message\n` +
    `\n` +
    `Token resolution order:\n` +
    `  1. $GH_TOKEN\n` +
    `  2. $GITHUB_TOKEN\n` +
    `  3. $OCTOMIL_RUNTIME_TOKEN\n` +
    `  4. \`gh auth token\` (via GitHub CLI)\n` +
    `\n` +
    `After extraction the dylib is available at:\n` +
    `  <cache-root>/<version>/lib/liboctomil-runtime.dylib\n`
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv) {
  const opts = parseArgs(argv);

  if (opts.help) {
    printHelp();
    return 0;
  }

  const { version, force } = opts;
  const cacheRoot = opts.cacheRoot.replace(/^~(?=\/|$)/, os.homedir());
  const targetDir = path.join(cacheRoot, version);
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

  process.stderr.write(`fetching octomil-runtime ${version} into ${targetDir}\n`);
  await fs.mkdir(targetDir, { recursive: true });
  const work = path.join(targetDir, "_download");
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

    const binName = platformAssetName(version);
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
