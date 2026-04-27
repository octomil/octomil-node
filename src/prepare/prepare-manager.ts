/**
 * Node port of Python's ``PrepareManager`` — bridge from a planner
 * candidate to on-disk artifact readiness.
 *
 * Single owner of artifact materialization for ``sdk_runtime``
 * candidates. Wraps :class:`DurableDownloader` (the actual byte
 * pump) and threads policy + cache + safe filesystem keys through
 * one consistent surface. The Node planner-introspection helper
 * ``prepareForFacade`` (in ``./prepare.ts``) now has an actual
 * downloader to call into when a host process opts in.
 *
 * Differences vs Python:
 *
 *   - Python's `PrepareManager.prepare(candidate, mode=)` takes a
 *     ``RuntimeCandidatePlan`` and returns a `PrepareOutcome`. Node
 *     mirrors the shape exactly: ``prepare(candidate, { mode })``
 *     returns ``Promise<NodePrepareOutcome>``.
 *   - The cache directory selection (``OCTOMIL_CACHE_DIR``,
 *     ``XDG_CACHE_HOME``, fallback to ``~/.cache/octomil/artifacts``)
 *     is duplicated here because Node has no equivalent of Python's
 *     ``ArtifactCache`` class today and we don't want a separate
 *     manifest yet. Add it later if eviction policy lands.
 *
 * @module prepare/prepare-manager
 */

import { homedir } from "node:os";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { OctomilError } from "../types.js";
import type {
  ArtifactDownloadEndpoint,
  PreparePolicy,
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
} from "../planner/types.js";
import {
  DurableDownloader,
  type ArtifactDescriptor,
  type DownloadEndpoint,
  type DurableDownloaderOptions,
  type RequiredFile,
  digestMatches,
  safeJoin,
  validateRelativePath,
} from "./durable-download.js";
import { safeFilesystemKey } from "./fs-key.js";

/**
 * Why ``prepare`` was called. ``LAZY`` is the runtime-driven default
 * (just-in-time during inference dispatch); ``EXPLICIT`` is the
 * caller-driven path (CLI, ``client.prepare(...)``). Explicit calls
 * are permitted even when the candidate's
 * ``prepare_policy === "explicit_only"``.
 */
export const PrepareMode = {
  LAZY: "lazy",
  EXPLICIT: "explicit",
} as const;

export type PrepareMode = (typeof PrepareMode)[keyof typeof PrepareMode];

export interface NodePrepareOutcome {
  artifactId: string;
  /** Directory the candidate's files live under (absolute path). */
  artifactDir: string;
  /** Maps each ``required_files`` entry to its on-disk path. For
   * single-file artifacts (empty ``relative_path``), ``files[""]``
   * is the same as ``<artifactDir>/artifact``. */
  files: Record<string, string>;
  engine: string | null;
  deliveryMode: string;
  preparePolicy: PreparePolicy;
  /** True when the files were already present + verified, so the
   * manager did no I/O. */
  cached: boolean;
}

export interface PrepareManagerOptions {
  /** Override the cache root. Defaults to
   * ``OCTOMIL_CACHE_DIR/artifacts`` then
   * ``XDG_CACHE_HOME/octomil/artifacts`` then
   * ``~/.cache/octomil/artifacts``. */
  cacheDir?: string;
  /** Inject a downloader (for tests). */
  downloader?: DurableDownloader;
  /** Forwarded to the default downloader. */
  downloaderOptions?: DurableDownloaderOptions;
}

/** Where artifacts live by default. Matches Python's
 * ``ArtifactCache._default_cache_dir`` so the Python and Node SDKs
 * read the same directory on the same host. */
function defaultCacheDir(): string {
  const root = process.env.OCTOMIL_CACHE_DIR;
  if (root) return path.join(root, "artifacts");
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "octomil", "artifacts");
  return path.join(homedir(), ".cache", "octomil", "artifacts");
}

/**
 * Bring a planner-emitted candidate to a ready local state.
 *
 * Single owner of the prepare contract. ``can_prepare()`` is a pure
 * dry-run; ``prepare()`` actually downloads + verifies. Lock files
 * live at ``<cacheDir>/.locks/`` and progress at
 * ``<cacheDir>/.progress.json``.
 */
export class PrepareManager {
  readonly cacheDir: string;
  private readonly downloader: DurableDownloader;

  constructor(options: PrepareManagerOptions = {}) {
    this.cacheDir = options.cacheDir ?? defaultCacheDir();
    fsSync.mkdirSync(this.cacheDir, { recursive: true });
    this.downloader = options.downloader ?? new DurableDownloader(this.cacheDir, options.downloaderOptions);
  }

  /**
   * Pure inspection — does NOT touch disk or network. Returns
   * ``true`` only when :meth:`prepare` is structurally guaranteed
   * to succeed on ``candidate``'s metadata. Synthetic / malformed
   * planner metadata returns ``false`` so the routing layer can
   * treat the candidate as unavailable.
   */
  canPrepare(candidate: RuntimeCandidatePlan): boolean {
    try {
      validateForPrepare(candidate);
      return true;
    } catch (err) {
      if (err instanceof OctomilError) return false;
      throw err;
    }
  }

  /**
   * Compute the deterministic ``<cacheDir>/<safeKey>`` directory for
   * an ``artifact_id``. Mirrors Python's ``artifact_dir_for`` so the
   * two SDKs land each artifact at identical paths on the same host
   * (lets a Python-side ``client.prepare`` populate the cache and a
   * Node-side dispatch read it).
   */
  artifactDirFor(artifactId: string): string {
    if (!artifactId) {
      throw new OctomilError(
        "INVALID_INPUT",
        "Refusing to prepare artifact with empty artifact_id.",
      );
    }
    let key: string;
    try {
      key = safeFilesystemKey(artifactId);
    } catch (err) {
      throw new OctomilError(
        "INVALID_INPUT",
        `artifact_id is not a valid filesystem key: ${(err as Error).message}`,
      );
    }
    const candidatePath = path.resolve(this.cacheDir, key);
    const baseResolved = path.resolve(this.cacheDir);
    const rel = path.relative(baseResolved, candidatePath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new OctomilError(
        "INVALID_INPUT",
        `artifact_id resolves outside the cache root: ${JSON.stringify(artifactId)} -> ${candidatePath}`,
      );
    }
    return candidatePath;
  }

  /**
   * Materialize a candidate's bytes on disk and return a
   * ``NodePrepareOutcome``. Throws :class:`OctomilError` when the
   * candidate is unpreparable, the policy forbids the caller, or
   * the download exhausts all endpoints.
   */
  async prepare(
    candidate: RuntimeCandidatePlan,
    options: { mode?: PrepareMode } = {},
  ): Promise<NodePrepareOutcome> {
    const mode = options.mode ?? PrepareMode.LAZY;

    // Single source of truth for structural validation; the same
    // checks ``canPrepare()`` exposes as a dry-run.
    validateForPrepare(candidate);
    checkExplicitOnlyVsMode(candidate, mode);

    if (!candidate.prepare_required) {
      // Server says no preparation is needed (engine manages its
      // own artifacts, e.g. an external endpoint). Return a
      // cached outcome with no files so callers have one shape.
      return {
        artifactId: artifactId(candidate),
        artifactDir: this.cacheDir,
        files: {},
        engine: candidate.engine ?? null,
        deliveryMode: candidate.delivery_mode ?? "sdk_runtime",
        preparePolicy: candidate.prepare_policy ?? "lazy",
        cached: true,
      };
    }

    const artifact = candidate.artifact;
    if (!artifact) {
      throw new OctomilError(
        "INVALID_INPUT",
        "Candidate marks prepare_required=true but carries no artifact plan. " +
          "This is a server contract violation; refusing to prepare.",
      );
    }

    const descriptor = buildDescriptor(artifact);
    const artifactDir = this.artifactDirFor(descriptor.artifactId);
    await fs.mkdir(artifactDir, { recursive: true });

    const cachedFiles = await alreadyVerified(descriptor, artifactDir);
    if (cachedFiles) {
      return {
        artifactId: descriptor.artifactId,
        artifactDir,
        files: cachedFiles,
        engine: candidate.engine ?? null,
        deliveryMode: candidate.delivery_mode ?? "sdk_runtime",
        preparePolicy: candidate.prepare_policy ?? "lazy",
        cached: true,
      };
    }

    const result = await this.downloader.download(descriptor, artifactDir);
    return {
      artifactId: descriptor.artifactId,
      artifactDir,
      files: result.files,
      engine: candidate.engine ?? null,
      deliveryMode: candidate.delivery_mode ?? "sdk_runtime",
      preparePolicy: candidate.prepare_policy ?? "lazy",
      cached: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Apply every structural check :meth:`PrepareManager.prepare` performs
 * before any disk/network work. Throws :class:`OctomilError` with an
 * actionable message on the first failure.
 *
 * Mirrors Python ``_validate_for_prepare``.
 */
export function validateForPrepare(candidate: RuntimeCandidatePlan): void {
  if (candidate.locality !== "local") {
    throw new OctomilError(
      "INVALID_INPUT",
      `Candidate locality is ${JSON.stringify(candidate.locality)}; ` +
        `only "local" candidates are preparable.`,
    );
  }
  const deliveryMode = candidate.delivery_mode ?? "sdk_runtime";
  if (deliveryMode !== "sdk_runtime") {
    throw new OctomilError(
      "INVALID_INPUT",
      `Candidate delivery_mode is ${JSON.stringify(deliveryMode)}; ` +
        `only "sdk_runtime" is preparable.`,
    );
  }
  if (candidate.prepare_policy === "disabled") {
    throw new OctomilError(
      "INVALID_INPUT",
      `Candidate prepare_policy is "disabled"; refusing to prepare.`,
    );
  }
  if (!candidate.prepare_required) {
    return;
  }
  const artifact = candidate.artifact;
  if (!artifact) {
    throw new OctomilError(
      "INVALID_INPUT",
      "Candidate has prepare_required=true but no artifact plan.",
    );
  }
  if (!artifact.digest) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Artifact '${artifact.artifact_id ?? artifact.model_id ?? "<anon>"}' is ` +
        `missing 'digest'; refusing to prepare without integrity.`,
    );
  }
  if (!artifact.download_urls || artifact.download_urls.length === 0) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Artifact '${artifact.artifact_id ?? artifact.model_id ?? "<anon>"}' has ` +
        `no download_urls. Cannot prepare; the planner must emit at least ` +
        `one endpoint.`,
    );
  }
  const requiredFiles = artifact.required_files ?? [];
  if (requiredFiles.length > 1) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Artifact '${artifact.artifact_id ?? artifact.model_id ?? "<anon>"}' lists ` +
        `${requiredFiles.length} required_files but the planner schema in this ` +
        `release only carries a single artifact-level digest. Multi-file ` +
        `artifacts require a per-file manifest_uri (planned in a follow-up PR); ` +
        `refusing to prepare without per-file integrity.`,
    );
  }
  if (requiredFiles.length === 1 && requiredFiles[0]) {
    validateRelativePath(requiredFiles[0]);
  }
  const id = artifact.artifact_id || artifact.model_id;
  if (!id) {
    throw new OctomilError(
      "INVALID_INPUT",
      "Refusing to prepare artifact with empty artifact_id.",
    );
  }
  if (id.includes("\u0000")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `artifact_id contains a NUL byte: ${JSON.stringify(id)}`,
    );
  }
}

function checkExplicitOnlyVsMode(candidate: RuntimeCandidatePlan, mode: PrepareMode): void {
  if (candidate.prepare_policy === "explicit_only" && mode === PrepareMode.LAZY) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Candidate has prepare_policy="explicit_only"; refusing to prepare ` +
        `lazily. The caller must opt in via PrepareManager.prepare(candidate, ` +
        `{ mode: PrepareMode.EXPLICIT }) (or the equivalent CLI / SDK call).`,
    );
  }
}

// ---------------------------------------------------------------------------
// Descriptor / cache helpers
// ---------------------------------------------------------------------------

function artifactId(candidate: RuntimeCandidatePlan): string {
  return candidate.artifact?.artifact_id || candidate.artifact?.model_id || "";
}

function buildDescriptor(artifact: RuntimeArtifactPlan): ArtifactDescriptor {
  const endpoints: DownloadEndpoint[] = (artifact.download_urls ?? []).map(
    (e: ArtifactDownloadEndpoint) => ({
      url: e.url,
      expiresAt: e.expires_at ?? undefined,
      headers: e.headers ?? undefined,
    }),
  );
  const files = artifact.required_files ?? [];
  let required: RequiredFile[];
  if (files.length === 1 && files[0]) {
    required = [
      {
        relativePath: validateRelativePath(files[0]),
        digest: artifact.digest!,
        sizeBytes: artifact.size_bytes ?? undefined,
      },
    ];
  } else {
    // Single-file (empty required_files): treat the endpoint URL as
    // the file URL directly. Same shape Python uses.
    required = [
      {
        relativePath: "",
        digest: artifact.digest!,
        sizeBytes: artifact.size_bytes ?? undefined,
      },
    ];
  }
  return {
    artifactId: artifact.artifact_id || artifact.model_id || "",
    requiredFiles: required,
    endpoints,
  };
}

/**
 * Return the file map iff every required file exists, sits under
 * ``artifactDir`` after symlink/path resolution, and matches its
 * digest. Returns ``null`` (cache miss) on any mismatch.
 */
async function alreadyVerified(
  descriptor: ArtifactDescriptor,
  artifactDir: string,
): Promise<Record<string, string> | null> {
  const verified: Record<string, string> = {};
  for (const required of descriptor.requiredFiles) {
    const target = required.relativePath
      ? safeJoin(artifactDir, required.relativePath)
      : path.join(path.resolve(artifactDir), "artifact");
    try {
      const stat = await fs.stat(target);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    if (!(await digestMatches(target, required.digest))) {
      return null;
    }
    verified[required.relativePath] = target;
  }
  return verified;
}
