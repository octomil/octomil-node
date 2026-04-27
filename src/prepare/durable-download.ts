/**
 * Durable, resumable, multi-URL artifact downloader.
 *
 * Port of Python ``octomil/runtime/lifecycle/durable_download.py``.
 *
 * Contract (mirror of Python):
 *
 *   - ``requiredFiles``: list of files comprising the artifact (relative
 *     POSIX paths). Single-file artifacts use ``relativePath: ""`` and the
 *     endpoint URL is treated as the file URL directly.
 *   - ``endpoints``: ordered fallback list of ``DownloadEndpoint``. The
 *     downloader walks them in order, skipping expired entries, until one
 *     succeeds or all are exhausted.
 *   - Progress journal: per-(artifact, relativePath) ``{bytesWritten,
 *     endpointIndex}`` persisted to a JSON sidecar at
 *     ``<cacheDir>/.progress.json``. Crash-resume reads the journal AND
 *     the on-disk ``.part`` size and clamps to the smaller. The journal
 *     is *advisory*; final bytes are always digest-verified.
 *
 * Differences vs Python:
 *
 *   - Python uses ``sqlite3`` for the journal; Node uses a single JSON
 *     file. Node's stdlib has no SQLite, and ``better-sqlite3`` is a
 *     native dep we'd rather avoid for a one-table progress journal.
 *     The JSON sidecar is loaded once at construction, mutated in
 *     memory, and rewritten atomically (tmp + rename) on every
 *     ``record()``/``clear()``. Same semantics; smaller surface.
 *   - Python uses ``httpx``; Node uses the global ``fetch`` available
 *     since Node 18. ``Range`` and ``If-Match`` headers are passed
 *     through identically. Streaming uses the response body's
 *     async iterator.
 *
 * @module prepare/durable-download
 */

import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OctomilError } from "../types.js";
import { FileLock } from "./file-lock.js";

const CHUNK_BYTES = 1 << 16; // 64 KiB
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min
const PROGRESS_FLUSH_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface DownloadEndpoint {
  /** Treated as a base for multi-file artifacts (full URL is
   * ``<url>/<relativePath>``) or as a direct file URL when the
   * artifact has a single file with empty relative path. */
  url: string;
  /** ISO-8601 timestamp; endpoints whose ``expiresAt`` is in the
   * past at fetch time are skipped before any HTTP request. */
  expiresAt?: string;
  /** Per-endpoint headers (e.g. ``Authorization`` for signed URLs). */
  headers?: Record<string, string>;
}

export interface RequiredFile {
  /** Path within the artifact root. ``""`` means the artifact is
   * single-file and the endpoint URL points directly at it. */
  relativePath: string;
  /** ``sha256:<hex>`` or bare hex; verified after the last byte
   * is written. */
  digest: string;
  /** Optional size hint for progress UIs; not required for resume. */
  sizeBytes?: number;
}

export interface ArtifactDescriptor {
  artifactId: string;
  requiredFiles: RequiredFile[];
  endpoints: DownloadEndpoint[];
}

export interface DownloadResult {
  artifactId: string;
  /** Resolved on-disk paths keyed by relative path. */
  files: Record<string, string>;
}

export interface DurableDownloaderOptions {
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Inject a custom fetch (for tests / proxies). */
  fetchImpl?: typeof fetch;
  /** Inject a clock for expiry checks (UTC ms since epoch). */
  now?: () => number;
}

/**
 * Resumable multi-URL multi-file artifact downloader.
 *
 * Single responsibility: given an :class:`ArtifactDescriptor` and a
 * destination directory, return verified on-disk paths or throw
 * :class:`OctomilError`.
 */
export class DurableDownloader {
  private readonly cacheDir: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly journal: ProgressJournal;

  constructor(cacheDir: string, options: DurableDownloaderOptions = {}) {
    this.cacheDir = cacheDir;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    fsSync.mkdirSync(cacheDir, { recursive: true });
    this.journal = new ProgressJournal(path.join(cacheDir, ".progress.json"));
  }

  /**
   * Download every file in the descriptor; return resolved paths.
   *
   * Throws :class:`OctomilError` if every endpoint is exhausted, a
   * digest verification fails after a complete download, or no
   * endpoints are usable (all expired before being tried).
   */
  async download(descriptor: ArtifactDescriptor, destDir: string): Promise<DownloadResult> {
    if (descriptor.endpoints.length === 0) {
      throw new OctomilError(
        "DOWNLOAD_FAILED",
        `Artifact '${descriptor.artifactId}' has no download endpoints.`,
      );
    }
    if (descriptor.requiredFiles.length === 0) {
      throw new OctomilError(
        "DOWNLOAD_FAILED",
        `Artifact '${descriptor.artifactId}' has no required_files.`,
      );
    }
    // Trust boundary: validate every planner-supplied path before any
    // filesystem or URL operation.
    for (const required of descriptor.requiredFiles) {
      validateRelativePath(required.relativePath);
    }

    await fs.mkdir(destDir, { recursive: true });
    const partsDir = path.join(destDir, ".parts");
    await fs.mkdir(partsDir, { recursive: true });

    const lock = new FileLock(descriptor.artifactId, {
      lockDir: path.join(this.cacheDir, ".locks"),
    });
    await lock.acquire();
    try {
      const files: Record<string, string> = {};
      for (const required of descriptor.requiredFiles) {
        files[required.relativePath] = await this.downloadOne(
          descriptor,
          required,
          destDir,
          partsDir,
        );
      }
      return { artifactId: descriptor.artifactId, files };
    } finally {
      await lock.release();
    }
  }

  private async downloadOne(
    descriptor: ArtifactDescriptor,
    required: RequiredFile,
    destDir: string,
    partsDir: string,
  ): Promise<string> {
    const safeRel = validateRelativePath(required.relativePath);
    const finalPath = safeRel
      ? safeJoin(destDir, safeRel)
      : path.join(path.resolve(destDir), "artifact");
    await fs.mkdir(path.dirname(finalPath), { recursive: true });

    if (await pathExists(finalPath)) {
      if (await digestMatches(finalPath, required.digest)) {
        return finalPath;
      }
    }

    const partName = (safeRel || "artifact").replaceAll("/", "_") + ".part";
    const partPath = path.join(partsDir, partName);

    const journalEntry = this.journal.get(descriptor.artifactId, required.relativePath);
    const onDisk = (await statSize(partPath)) ?? 0;
    // Trust the smaller — journal may be ahead of disk if the process
    // died mid-flush, or disk may be ahead of the journal flush rate.
    let offset = Math.min(journalEntry.bytesWritten, onDisk);
    if (offset !== onDisk && (await pathExists(partPath))) {
      const fd = await fs.open(partPath, "r+");
      try {
        await fd.truncate(offset);
      } finally {
        await fd.close();
      }
    }

    let lastError: Error | null = null;
    // Start with the journal's last endpoint, then walk the rest in
    // order. Stable: same endpoint ordering across retries.
    const orderedIndices = orderEndpoints(
      descriptor.endpoints.length,
      journalEntry.endpointIndex,
    );

    for (const index of orderedIndices) {
      const endpoint = descriptor.endpoints[index];
      if (!endpoint) continue;
      if (isExpired(endpoint, this.now())) {
        continue;
      }
      try {
        await this.fetchOne(endpoint, required, partPath, offset, descriptor.artifactId, index);
        if (!(await digestMatches(partPath, required.digest))) {
          await fs.unlink(partPath).catch(() => undefined);
          this.journal.clear(descriptor.artifactId, required.relativePath);
          offset = 0;
          lastError = new OctomilError(
            "CHECKSUM_MISMATCH",
            `Digest mismatch for '${descriptor.artifactId}' file ` +
              `'${required.relativePath}' from endpoint ${index}.`,
          );
          continue;
        }
        await fs.rename(partPath, finalPath);
        this.journal.clear(descriptor.artifactId, required.relativePath);
        return finalPath;
      } catch (err) {
        lastError = err as Error;
        const status = (err as { status?: number }).status;
        if (status !== undefined && [401, 403, 404, 410].includes(status)) {
          // The URL itself is dead — drop progress so the next
          // endpoint starts clean rather than resuming from a
          // .part the new URL doesn't know about.
          await fs.unlink(partPath).catch(() => undefined);
          this.journal.clear(descriptor.artifactId, required.relativePath);
          offset = 0;
        } else {
          // Re-read disk for next attempt (partial bytes may have landed).
          offset = (await statSize(partPath)) ?? 0;
        }
      }
    }

    throw new OctomilError(
      "DOWNLOAD_FAILED",
      `Exhausted all endpoints for '${descriptor.artifactId}' file ` +
        `'${required.relativePath}'. Last error: ${lastError?.message ?? "unknown"}`,
    );
  }

  private async fetchOne(
    endpoint: DownloadEndpoint,
    required: RequiredFile,
    partPath: string,
    offset: number,
    artifactId: string,
    endpointIndex: number,
  ): Promise<void> {
    const safeRel = validateRelativePath(required.relativePath);
    const url = resolveUrl(endpoint.url, safeRel);
    const headers: Record<string, string> = { ...(endpoint.headers ?? {}) };
    if (offset > 0) {
      headers["Range"] = `bytes=${offset}-`;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    timeoutHandle.unref?.();

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (response.status === 416 && offset > 0) {
        // Stale resume offset (journal/disk says we're past EOF).
        // Drop progress, retry the same endpoint once from zero.
        await response.body?.cancel();
        await fs.unlink(partPath).catch(() => undefined);
        this.journal.clear(artifactId, required.relativePath);
        const freshHeaders = { ...headers };
        delete freshHeaders["Range"];
        const retry = await this.fetchImpl(url, {
          method: "GET",
          headers: freshHeaders,
          signal: controller.signal,
        });
        if (retry.status !== 200) {
          throw httpStatusError(retry);
        }
        await this.streamToPart(retry, partPath, 0, artifactId, required.relativePath, endpointIndex);
        return;
      }
      if (response.status !== 200 && response.status !== 206) {
        throw httpStatusError(response);
      }
      const resume = response.status === 206 && offset > 0;
      await this.streamToPart(
        response,
        partPath,
        resume ? offset : 0,
        artifactId,
        required.relativePath,
        endpointIndex,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async streamToPart(
    response: Response,
    partPath: string,
    offset: number,
    artifactId: string,
    relativePath: string,
    endpointIndex: number,
  ): Promise<void> {
    if (!response.body) {
      throw new OctomilError(
        "DOWNLOAD_FAILED",
        `Response body missing for ${response.url}`,
      );
    }
    const flag = offset > 0 ? "a" : "w";
    const fd = await fs.open(partPath, flag);
    let bytesWritten = offset;
    let lastFlush = bytesWritten;
    try {
      // ``fetch``'s Body.body is a ``ReadableStream<Uint8Array>``;
      // Node 18+ supports the async iterator protocol over it.
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        // Write in CHUNK_BYTES-sized blocks so back-pressure is
        // bounded even when fetch hands us large slabs.
        for (let pos = 0; pos < value.byteLength; pos += CHUNK_BYTES) {
          const slice = value.subarray(pos, Math.min(pos + CHUNK_BYTES, value.byteLength));
          await fd.write(slice);
          bytesWritten += slice.byteLength;
          if (bytesWritten - lastFlush >= PROGRESS_FLUSH_BYTES) {
            await fd.sync();
            this.journal.record(artifactId, relativePath, bytesWritten, endpointIndex);
            lastFlush = bytesWritten;
          }
        }
      }
      await fd.sync();
    } finally {
      await fd.close();
    }
    this.journal.record(artifactId, relativePath, bytesWritten, endpointIndex);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isExpired(endpoint: DownloadEndpoint, nowMs: number): boolean {
  if (!endpoint.expiresAt) return false;
  const ms = Date.parse(endpoint.expiresAt);
  if (Number.isNaN(ms)) return false;
  return nowMs >= ms;
}

function orderEndpoints(count: number, preferred: number): number[] {
  const indices = Array.from({ length: count }, (_, i) => i);
  if (preferred < 0 || preferred >= count) return indices;
  return [preferred, ...indices.filter((i) => i !== preferred)];
}

function resolveUrl(base: string, relativePath: string): string {
  if (!relativePath) return base;
  return `${base.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

/**
 * Reject planner-supplied paths that could escape the artifact dir.
 * Server input is untrusted at this boundary. Anything that resolves
 * outside the destination directory or smuggles platform-specific
 * separators is rejected before any filesystem or URL operation.
 *
 * Mirror of Python ``_validate_relative_path``.
 */
export function validateRelativePath(relativePath: string): string {
  if (relativePath === "") return "";
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
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path must not contain '.', '..', or empty segments: ${JSON.stringify(
        relativePath,
      )}`,
    );
  }
  if (relativePath.startsWith("/")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path must be relative, got: ${JSON.stringify(relativePath)}`,
    );
  }
  // Block Windows drive letters (``C:foo``) and UNC-like prefixes.
  if (/^[A-Za-z]:/.test(relativePath)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path looks like a Windows drive: ${JSON.stringify(relativePath)}`,
    );
  }
  return relativePath;
}

/**
 * Resolve ``relativePath`` under ``destDir`` and confirm containment.
 * Defends against symlink and ``..`` shenanigans even after the
 * structural validation above.
 */
export function safeJoin(destDir: string, relativePath: string): string {
  const safe = validateRelativePath(relativePath);
  const baseResolved = path.resolve(destDir);
  if (!safe) return baseResolved;
  const candidate = path.resolve(baseResolved, safe);
  const rel = path.relative(baseResolved, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Required file path resolves outside the artifact directory: ` +
        `${JSON.stringify(relativePath)} -> ${candidate}`,
    );
  }
  return candidate;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function statSize(p: string): Promise<number | null> {
  try {
    const stat = await fs.stat(p);
    return stat.size;
  } catch {
    return null;
  }
}

/**
 * Verify a file's SHA-256 against ``expected``. Accepts either
 * ``sha256:<hex>`` or bare hex; comparison is case-insensitive.
 */
export async function digestMatches(filePath: string, expected: string): Promise<boolean> {
  if (!(await pathExists(filePath))) return false;
  const expectedHex = (expected.startsWith("sha256:") ? expected.slice(7) : expected).toLowerCase();
  const hash = createHash("sha256");
  const fd = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await fd.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  return hash.digest("hex") === expectedHex;
}

/**
 * Wrap an HTTP non-2xx response in an Error that carries the status
 * code. ``downloadOne`` inspects ``.status`` to decide whether to drop
 * progress (401/403/404/410) or retry.
 */
function httpStatusError(response: Response): Error {
  const err = new Error(`HTTP ${response.status} ${response.statusText} for ${response.url}`);
  (err as { status?: number }).status = response.status;
  return err;
}

// ---------------------------------------------------------------------------
// JSON-backed progress journal
// ---------------------------------------------------------------------------

interface ProgressEntry {
  bytesWritten: number;
  endpointIndex: number;
  updatedAt: number;
}

interface ProgressFile {
  // Two-level keyed by artifactId, then by relativePath.
  entries: Record<string, Record<string, ProgressEntry>>;
}

class ProgressJournal {
  private readonly dbPath: string;
  private state: ProgressFile;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fsSync.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.state = this.load();
  }

  get(artifactId: string, relativePath: string): ProgressEntry {
    return (
      this.state.entries[artifactId]?.[relativePath] ?? {
        bytesWritten: 0,
        endpointIndex: 0,
        updatedAt: 0,
      }
    );
  }

  record(
    artifactId: string,
    relativePath: string,
    bytesWritten: number,
    endpointIndex: number,
  ): void {
    if (!this.state.entries[artifactId]) {
      this.state.entries[artifactId] = {};
    }
    this.state.entries[artifactId][relativePath] = {
      bytesWritten,
      endpointIndex,
      updatedAt: Date.now(),
    };
    this.flush();
  }

  clear(artifactId: string, relativePath: string): void {
    const slot = this.state.entries[artifactId];
    if (!slot) return;
    delete slot[relativePath];
    if (Object.keys(slot).length === 0) {
      delete this.state.entries[artifactId];
    }
    this.flush();
  }

  private load(): ProgressFile {
    try {
      const raw = fsSync.readFileSync(this.dbPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        return parsed as ProgressFile;
      }
    } catch {
      // Corrupt or missing — start fresh. The journal is advisory;
      // ``downloadOne`` re-checks the on-disk ``.part`` size before
      // trusting any offset.
    }
    return { entries: {} };
  }

  private flush(): void {
    // Atomic write: tmp + rename so a crash mid-write doesn't leave
    // a half-written JSON the next process can't parse.
    const tmpPath = `${this.dbPath}.tmp`;
    fsSync.writeFileSync(tmpPath, JSON.stringify(this.state));
    fsSync.renameSync(tmpPath, this.dbPath);
  }
}
