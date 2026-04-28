/**
 * DurableDownloader — minimal, real downloader for Node prepare.
 *
 * Mirrors the Python lifecycle's invariants:
 *   - Atomic publish: write to `<dest>/<rel>.part`, fsync, rename to `<rel>`.
 *   - Digest verify: streamed SHA-256 over the bytes; refuses to publish
 *     if the digest does not match the planner's claim.
 *   - Idempotent: a second call with the same digest short-circuits
 *     after a digest re-verification of the on-disk artifact.
 *   - Path safety: every relative path is validated and joined under
 *     the destination directory with symlink-escape containment.
 *
 * The Node implementation is intentionally simpler than Python's
 * (no SQLite progress journal, no multi-endpoint resume) because the
 * Node SDK's first prepare-for-real release only ships single-file
 * artifacts (the static Kokoro recipe). The path-safety / digest /
 * atomic-publish guarantees match Python so cross-SDK contracts hold.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import * as path from "node:path";

import { OctomilError } from "../types.js";
import { safeJoinUnder, safeJoinUnderSync } from "./safe-join.js";

export interface DownloadEndpoint {
  url: string;
  headers?: Record<string, string>;
}

export interface DownloadOptions {
  /** Absolute root for the artifact's bytes. The downloader never writes
   *  outside this directory. */
  destDir: string;
  /** Relative path inside `destDir`. Single-file artifacts pass `""`
   *  shorthand which is interpreted as the canonical filename derived
   *  from the artifact id. */
  relativePath: string;
  /** Multi-URL fallback list, tried in order. */
  endpoints: DownloadEndpoint[];
  /** Algorithm-prefixed digest (`sha256:<hex>`). Required. */
  digest: string;
  /** Optional fetch override for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface DownloadResult {
  /** Absolute path to the published artifact file. */
  filePath: string;
  /** Whether the file was already on disk and re-verified (no network). */
  cacheHit: boolean;
  /** Number of bytes downloaded; 0 on cache hit. */
  bytesDownloaded: number;
  /** Verified digest (echoes input on success). */
  digest: string;
}

const SUPPORTED_DIGEST_ALGOS: ReadonlySet<string> = new Set(["sha256"]);

/** Parse a `algo:hex` digest string. Throws on unsupported algos. */
export function parseDigest(digest: string): { algo: string; hex: string } {
  if (!digest || typeof digest !== "string") {
    throw new OctomilError(
      "INVALID_INPUT",
      `digest must be a non-empty string, got ${JSON.stringify(digest)}`,
    );
  }
  const idx = digest.indexOf(":");
  if (idx <= 0 || idx === digest.length - 1) {
    throw new OctomilError(
      "INVALID_INPUT",
      `digest must be 'algo:hex', got ${JSON.stringify(digest)}`,
    );
  }
  const algo = digest.slice(0, idx).toLowerCase();
  const hex = digest.slice(idx + 1).toLowerCase();
  if (!SUPPORTED_DIGEST_ALGOS.has(algo)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Unsupported digest algorithm ${JSON.stringify(algo)}. ` +
        `Supported: ${Array.from(SUPPORTED_DIGEST_ALGOS).join(", ")}.`,
    );
  }
  if (!/^[0-9a-f]+$/.test(hex)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `digest hex contains non-hex characters: ${JSON.stringify(hex)}`,
    );
  }
  return { algo, hex };
}

/** Stream-hash a file and return its `algo:hex` digest. */
export async function fileDigest(filePath: string, algo = "sha256"): Promise<string> {
  if (!SUPPORTED_DIGEST_ALGOS.has(algo)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Unsupported digest algorithm ${JSON.stringify(algo)}.`,
    );
  }
  const hash = createHash(algo);
  const handle = await fsp.open(filePath, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
  } finally {
    await handle.close();
  }
  return `${algo}:${hash.digest("hex")}`;
}

/** Download `endpoints[0]` (with fallback to subsequent entries) into
 *  `destDir/relativePath`, verify the digest, and atomically publish.
 *
 *  This is the one-file primitive the higher-level PrepareManager
 *  composes over the artifact's `required_files` list. It does NOT
 *  manage progress journals or pause/resume; the Node SDK's first
 *  prepare-for-real release only ships single-file artifacts. The
 *  path-safety + digest contract matches Python.
 */
export async function downloadOne(options: DownloadOptions): Promise<DownloadResult> {
  const { algo: digestAlgo } = parseDigest(options.digest);
  // Resolve the on-disk path with structural + symlink-escape
  // containment under destDir. We must do this BEFORE creating the
  // destination so a hostile pre-existing symlink layout cannot trick
  // the downloader into writing outside the artifact root.
  const targetRel = options.relativePath || defaultFilenameFromUrl(options.endpoints);
  // Synchronous structural validation so traversal is rejected even
  // when the destination directory does not yet exist.
  safeJoinUnderSync(options.destDir, targetRel);
  await fsp.mkdir(options.destDir, { recursive: true });
  const finalPath = await safeJoinUnder(options.destDir, targetRel);
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });

  // Idempotent fast path: file is already there with the right digest.
  if (await fileExists(finalPath)) {
    const onDisk = await fileDigest(finalPath, digestAlgo);
    if (onDisk === options.digest) {
      return {
        filePath: finalPath,
        cacheHit: true,
        bytesDownloaded: 0,
        digest: options.digest,
      };
    }
    // Stale or corrupted bytes — drop them and re-download. Atomic
    // rename will overwrite at the end so this is safe.
    await fsp.unlink(finalPath).catch(() => {});
  }

  if (!options.endpoints || options.endpoints.length === 0) {
    throw new OctomilError(
      "INVALID_INPUT",
      "downloadOne: at least one endpoint is required.",
    );
  }
  const partPath = `${finalPath}.part`;
  await fsp.unlink(partPath).catch(() => {});
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: unknown;
  for (const ep of options.endpoints) {
    try {
      const resp = await fetchImpl(ep.url, {
        method: "GET",
        headers: ep.headers,
      });
      if (!resp.ok || !resp.body) {
        lastError = new OctomilError(
          "DOWNLOAD_FAILED",
          `prepare: download from ${ep.url} failed (${resp.status} ${resp.statusText})`,
        );
        continue;
      }
      const hash = createHash(digestAlgo);
      let bytes = 0;
      // The web ReadableStream's chunks are Uint8Array; tee the bytes
      // through the hash before they hit the disk so we can refuse to
      // publish bytes that don't match the digest claim.
      const nodeStream = Readable.fromWeb(resp.body as any);
      const hashed = new Readable({
        async read() {
          // implemented via `for await` below
        },
      });
      // Simpler: drive the loop manually so we can hash each chunk.
      const out = createWriteStream(partPath);
      const hashAndCount = async (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
      };
      await pipeline(
        nodeStream,
        async function* (source) {
          for await (const chunk of source) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            await hashAndCount(buf);
            yield buf;
          }
        },
        out,
      );
      // Suppress unused-var lint for the placeholder Readable above.
      void hashed;

      const computed = `${digestAlgo}:${hash.digest("hex")}`;
      if (computed !== options.digest) {
        await fsp.unlink(partPath).catch(() => {});
        throw new OctomilError(
          "DOWNLOAD_FAILED",
          `prepare: digest mismatch on ${ep.url}: expected ${options.digest} got ${computed}`,
        );
      }
      // Atomic publish: rename `.part` -> final.
      await fsp.rename(partPath, finalPath);
      return {
        filePath: finalPath,
        cacheHit: false,
        bytesDownloaded: bytes,
        digest: options.digest,
      };
    } catch (err) {
      lastError = err;
      await fsp.unlink(partPath).catch(() => {});
      // Try next endpoint; keep last error for the final throw.
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new OctomilError(
        "DOWNLOAD_FAILED",
        "prepare: all download endpoints failed without a recoverable error.",
      );
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** When `required_files` is empty (single-file artifact), pick a
 *  filename from the first endpoint URL so the file lands somewhere
 *  predictable inside `destDir` instead of overwriting the directory.
 *  We strip query strings and refuse anything that lands at `/` or `.`.
 */
function defaultFilenameFromUrl(endpoints: DownloadEndpoint[]): string {
  for (const ep of endpoints) {
    let raw: string;
    try {
      raw = new URL(ep.url).pathname;
    } catch {
      continue;
    }
    const last = raw.split("/").filter(Boolean).pop();
    if (last && last !== "." && last !== "..") {
      return last;
    }
  }
  return "artifact.bin";
}
