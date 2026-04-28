/**
 * PrepareManager — orchestrates the on-device artifact lifecycle for
 * Node, mirroring the Python PrepareManager's contract:
 *
 *   1. Validate the planner candidate (no traversal, has digest, has
 *      download URLs, prepare_required, single-file or future-typed).
 *   2. Download the bytes durably (atomic publish, digest verify).
 *   3. Materialize the bytes into a runtime layout the engine consumes.
 *   4. Return a structured outcome describing what landed on disk so
 *      the facade can thread `model_dir` into create/warmup.
 *
 * Strict by default: when an artifact's digest is missing, the
 * download_urls list is empty, or required_files contain traversal,
 * the manager refuses to materialize. Substitution (e.g., "use a
 * different artifact for this app") is the facade's job, not the
 * manager's — keeping it that way means the manager's contract stays
 * narrow enough to mirror across SDKs without ambiguity.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { OctomilError } from "../types.js";
import type {
  ArtifactDownloadEndpoint,
  RuntimeCandidatePlan,
} from "../planner/types.js";

import { downloadOne, fileDigest } from "./durable-downloader.js";
import type { DownloadEndpoint } from "./durable-downloader.js";
import { materializeFile } from "./materializer.js";
import { safeJoinUnderSync, validateRelativePath } from "./safe-join.js";

export interface PrepareManagerOptions {
  /** Cache root where prepared artifacts live. Defaults to
   *  `<homedir>/.cache/octomil/runtime`. Tests pass an explicit path
   *  so each run gets an isolated layout. */
  cacheRoot?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Result of a successful PrepareManager run. */
export interface MaterializedArtifact {
  artifactId: string;
  modelId: string;
  /** Runtime layout root the engine should consume as `model_dir`. */
  modelDir: string;
  /** Absolute path of the primary file inside `modelDir`. */
  primaryPath: string;
  digest: string;
  cacheHit: boolean;
  bytesDownloaded: number;
}

export class PrepareManager {
  private readonly cacheRoot: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: PrepareManagerOptions = {}) {
    this.cacheRoot = options.cacheRoot ?? defaultCacheRoot();
    this.fetchImpl = options.fetchImpl;
  }

  /** Best-effort containment check, mirrors Python `can_prepare`. */
  static canPrepare(candidate: RuntimeCandidatePlan): boolean {
    if (candidate.locality !== "local") return false;
    const deliveryMode = candidate.delivery_mode ?? "sdk_runtime";
    if (deliveryMode !== "sdk_runtime") return false;
    if (candidate.prepare_policy === "disabled") return false;
    if (candidate.prepare_required === false) return true;
    const artifact = candidate.artifact;
    if (!artifact) return false;
    if (!artifact.digest) return false;
    if (!artifact.download_urls || artifact.download_urls.length === 0) {
      return false;
    }
    const required = artifact.required_files ?? [];
    if (required.length > 1) return false;
    if (required.length === 1) {
      try {
        validateRelativePath(required[0]!);
      } catch {
        return false;
      }
    }
    if (!(artifact.artifact_id || artifact.model_id)) return false;
    return true;
  }

  /** Run the full prepare lifecycle for `candidate`. Throws
   *  {@link OctomilError} on every contract violation. */
  async prepare(candidate: RuntimeCandidatePlan): Promise<MaterializedArtifact> {
    if (candidate.locality !== "local") {
      throw new OctomilError(
        "INVALID_INPUT",
        "PrepareManager: only local sdk_runtime candidates are preparable.",
      );
    }
    const deliveryMode = candidate.delivery_mode ?? "sdk_runtime";
    if (deliveryMode !== "sdk_runtime") {
      throw new OctomilError(
        "INVALID_INPUT",
        `PrepareManager: delivery_mode ${JSON.stringify(deliveryMode)} is not sdk_runtime.`,
      );
    }
    if (candidate.prepare_policy === "disabled") {
      throw new OctomilError(
        "INVALID_INPUT",
        "PrepareManager: candidate.prepare_policy is 'disabled'.",
      );
    }
    const artifact = candidate.artifact;
    if (!artifact) {
      throw new OctomilError(
        "INVALID_INPUT",
        "PrepareManager: candidate carries no artifact plan.",
      );
    }
    if (!artifact.digest) {
      throw new OctomilError(
        "INVALID_INPUT",
        `PrepareManager: artifact ${JSON.stringify(artifact.artifact_id ?? artifact.model_id)} has no digest. ` +
          `Refusing to materialize without integrity verification.`,
      );
    }
    if (!artifact.download_urls || artifact.download_urls.length === 0) {
      throw new OctomilError(
        "INVALID_INPUT",
        `PrepareManager: artifact has no download_urls.`,
      );
    }
    const requiredFiles = artifact.required_files ?? [];
    if (requiredFiles.length > 1) {
      throw new OctomilError(
        "INVALID_INPUT",
        `PrepareManager: multi-file artifacts (${requiredFiles.length} files) are not yet supported. ` +
          `Per-file manifest_uri integrity is required first.`,
      );
    }
    if (requiredFiles.length === 1) {
      validateRelativePath(requiredFiles[0]!);
    }

    const artifactId = artifact.artifact_id || artifact.model_id;
    if (!artifactId) {
      throw new OctomilError(
        "INVALID_INPUT",
        "PrepareManager: artifact_id is empty.",
      );
    }
    const fsKey = sanitizeFsKey(artifactId);
    const artifactRoot = path.join(this.cacheRoot, "artifacts", fsKey);
    const runtimeDir = path.join(this.cacheRoot, "runtime", fsKey);
    // Synchronous containment for the resolved artifact root —
    // sanitized id can't escape `cacheRoot/artifacts`.
    safeJoinUnderSync(path.join(this.cacheRoot, "artifacts"), fsKey);
    safeJoinUnderSync(path.join(this.cacheRoot, "runtime"), fsKey);
    await fsp.mkdir(artifactRoot, { recursive: true });

    const relativePath =
      requiredFiles.length === 1 ? requiredFiles[0]! : ""; // empty -> URL-derived
    const endpoints: DownloadEndpoint[] = artifact.download_urls.map(
      (ep: ArtifactDownloadEndpoint) => ({
        url: ep.url,
        headers: ep.headers,
      }),
    );

    const downloadResult = await downloadOne({
      destDir: artifactRoot,
      relativePath,
      endpoints,
      digest: artifact.digest,
      fetchImpl: this.fetchImpl,
    });

    // Idempotent cache hit: re-verify the bytes against the digest
    // even when we hit the cache, then materialize. The materializer
    // runs a size-equal short-circuit so the runtime copy step is
    // skipped on warm starts.
    if (downloadResult.cacheHit) {
      const reverify = await fileDigest(downloadResult.filePath);
      if (reverify !== artifact.digest) {
        throw new OctomilError(
          "DOWNLOAD_FAILED",
          `PrepareManager: cached artifact failed digest re-verification. ` +
            `expected ${artifact.digest} got ${reverify}`,
        );
      }
    }

    const materialized = await materializeFile({
      sourcePath: downloadResult.filePath,
      runtimeDir,
      relativePath:
        relativePath || path.basename(downloadResult.filePath),
    });

    return {
      artifactId: artifact.artifact_id ?? artifact.model_id,
      modelId: artifact.model_id,
      modelDir: runtimeDir,
      primaryPath: materialized.destPath,
      digest: artifact.digest,
      cacheHit: downloadResult.cacheHit && materialized.cacheHit,
      bytesDownloaded: downloadResult.bytesDownloaded,
    } satisfies MaterializedArtifact;
  }

  get cacheRootPath(): string {
    return this.cacheRoot;
  }
}

function defaultCacheRoot(): string {
  const home = process.env.OCTOMIL_CACHE_ROOT;
  if (home) return home;
  return path.join(os.homedir(), ".cache", "octomil", "runtime");
}

/** Map an `artifact_id` (which may legitimately contain ``/`` and other
 *  characters) into a single filesystem-safe segment. Mirrors Python's
 *  `_fs_key` sanitizer just well enough for our cache layout —
 *  collisions only matter cross-artifact, never cross-version, so a
 *  stable hash suffix would be overkill here. */
function sanitizeFsKey(artifactId: string): string {
  if (!artifactId) {
    throw new OctomilError("INVALID_INPUT", "artifact_id is empty.");
  }
  const cleaned = artifactId.replace(/[^A-Za-z0-9._-]+/g, "_");
  // Belt-and-braces: the result must not be empty, "." or "..".
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    throw new OctomilError(
      "INVALID_INPUT",
      `artifact_id sanitizes to an unsafe segment: ${JSON.stringify(artifactId)}`,
    );
  }
  return cleaned;
}
