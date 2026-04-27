/**
 * Octomil prepare-lifecycle facade for Node.
 *
 * Mirrors the Python `client.prepare(...)` UX: resolve a runtime plan for
 * `model + capability`, find the local sdk_runtime candidate, validate that
 * the planner emitted enough metadata to actually prepare it, and return a
 * structured outcome describing the artifact.
 *
 * The Node SDK does not materialize artifacts on its own yet (the durable
 * downloader lives in Python). For first-run experiences on Node, the
 * Octomil CLI's `octomil prepare` should be invoked from the host process
 * — this method is the planner-introspection half of the contract and
 * surfaces the same actionable errors as Python so callers can decide
 * whether to shell out, throw, or fall back to cloud.
 */

import { collectDeviceRuntimeProfile } from "../planner/device-profile.js";
import type { RuntimePlannerClient } from "../planner/client.js";
import type {
  ArtifactDownloadEndpoint,
  PlannerCapability,
  PreparePolicy,
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
  RuntimePlanResponse,
} from "../planner/types.js";
import { OctomilError } from "../types.js";

/** Capabilities `prepare()` understands. Mirror of Python
 * `_PREPAREABLE_CAPABILITIES`.
 *
 * Only `"tts"` is wired today — it is the one capability whose dispatch
 * path threads the prepared `model_dir` into the backend. Transcription,
 * embedding, chat, and responses will be added one at a time as their
 * backends learn to consume the prepared directory; until then,
 * accepting them here would let the SDK download bytes the next
 * inference call ignores. Python narrowed to {tts} in #444 for the same
 * reason; this Set keeps the two SDKs in lock-step. */
export const PREPAREABLE_CAPABILITIES: ReadonlySet<PlannerCapability> =
  new Set<PlannerCapability>(["tts"]);

/** Result of a successful `prepare(...)` call.
 *
 * `prepared = false` is reserved for the future — once the Node SDK gains
 * its own durable downloader, this flag will flip to true after the bytes
 * land on disk. Today, prepare returns the planner's intent and leaves
 * materialization to the Python CLI. */
export interface PrepareOutcome {
  artifactId: string;
  modelId: string;
  capability: PlannerCapability;
  deliveryMode: "sdk_runtime";
  preparePolicy: PreparePolicy;
  prepareRequired: boolean;
  /** Server-issued download endpoints. Multi-URL fallback list. */
  downloadUrls: ArtifactDownloadEndpoint[];
  /** Files inside the artifact. Empty list = single-file artifact. */
  requiredFiles: string[];
  digest: string | null;
  manifestUri: string | null;
  /** True iff a ``materializer`` was provided in :func:`prepareForFacade`
   * options AND the bytes are now on disk verified. */
  prepared: boolean;
  /** Set when ``prepared === true``. Absolute on-disk path the
   * artifact lives under. */
  artifactDir?: string | null;
  /** Set when ``prepared === true``. Maps each ``requiredFiles`` entry
   * to its on-disk path; ``files[""]`` for single-file artifacts. */
  files?: Record<string, string> | null;
}

export interface PrepareOptions {
  model: string;
  capability?: PlannerCapability;
  routingPolicy?: string;
  appSlug?: string;
  /** When provided, ``prepareForFacade`` runs the planner's candidate
   * through this materializer and the returned ``PrepareOutcome``
   * carries ``prepared: true`` plus the on-disk path. When omitted,
   * the function preserves its pre-PR-12 contract (planner-introspection
   * only; ``prepared: false``). Pass a fresh
   * :class:`PrepareManager` from ``./prepare-manager.js`` for real
   * downloads.
   *
   * The materializer is invoked with ``mode: 'explicit'`` because
   * ``prepareForFacade`` is the caller-driven path (CLI /
   * ``client.prepare(...)``) — the equivalent of Python's
   * ``client.prepare(...)`` calling ``PrepareManager.prepare(
   * candidate, mode=PrepareMode.EXPLICIT)``. Without this,
   * artifacts whose ``prepare_policy === "explicit_only"`` would
   * fail when called through the public facade even though the
   * facade IS the explicit caller. */
  materializer?: {
    prepare: (
      candidate: RuntimeCandidatePlan,
      options: { mode: "lazy" | "explicit" },
    ) => Promise<MaterializedArtifact>;
  };
}

/** What a materializer reports back after pulling bytes onto disk.
 * Shape-compatible with :class:`NodePrepareOutcome` so the SDK can
 * cleanly evolve. */
export interface MaterializedArtifact {
  artifactDir: string;
  files: Record<string, string>;
}

/** Resolve a planner candidate and return a `PrepareOutcome`.
 *
 * Throws {@link OctomilError} when the capability is unknown, the planner
 * is unavailable, no local sdk_runtime candidate is emitted, or the
 * candidate's metadata is structurally insufficient to prepare. */
export async function prepareForFacade(
  plannerClient: RuntimePlannerClient,
  options: PrepareOptions,
): Promise<PrepareOutcome> {
  const capability: PlannerCapability = options.capability ?? "tts";
  if (!PREPAREABLE_CAPABILITIES.has(capability)) {
    throw new OctomilError(
      "INVALID_INPUT",
      `client.prepare() does not yet support capability ${JSON.stringify(capability)}. ` +
        `Supported today: ${Array.from(PREPAREABLE_CAPABILITIES).sort().join(", ")}. ` +
        `Other capabilities will be added once their backends thread the prepared model_dir into dispatch.`,
    );
  }

  const device = await collectDeviceRuntimeProfile();
  const plan = await plannerClient.fetchPlan({
    model: options.model,
    capability,
    routing_policy: options.routingPolicy,
    app_slug: options.appSlug,
    device,
  });
  if (!plan) {
    throw new OctomilError(
      "RUNTIME_UNAVAILABLE",
      "prepare: planner is unavailable (network failure or unauthorized). " +
        "Without a planner response the SDK cannot determine which artifact to materialize.",
    );
  }

  const candidate = pickLocalSdkRuntimeCandidate(plan);
  if (!candidate) {
    throw new OctomilError(
      "RUNTIME_UNAVAILABLE",
      `prepare: planner returned no local sdk_runtime candidate for model=${JSON.stringify(options.model)} ` +
        `capability=${JSON.stringify(capability)}. The model is either cloud-only or the planner ` +
        `is configured to deliver via the hosted gateway.`,
    );
  }

  validatePreparable(candidate);

  // `validatePreparable` guarantees `artifact` is present when
  // `prepare_required=true`. For `prepare_required=false`, the engine
  // manages its own bytes and the planner may legitimately omit the
  // artifact plan, so we surface a no-files outcome with the candidate's
  // engine id instead of dereferencing `artifact`.
  const artifact = candidate.artifact;
  const prepareRequired = candidate.prepare_required ?? false;
  if (!prepareRequired && !artifact) {
    return {
      artifactId: candidate.engine ?? "",
      modelId: candidate.engine ?? "",
      capability,
      deliveryMode: "sdk_runtime",
      preparePolicy: candidate.prepare_policy ?? "lazy",
      prepareRequired: false,
      downloadUrls: [],
      requiredFiles: [],
      digest: null,
      manifestUri: null,
      prepared: false,
      artifactDir: null,
      files: null,
    };
  }
  // Type-narrowed by the early return above + the validator's guarantee.
  const safeArtifact: RuntimeArtifactPlan = artifact!;
  // PR 12: when a materializer is provided, run it now so the
  // returned outcome carries ``prepared: true`` + the on-disk
  // ``artifactDir`` / ``files`` paths. ``PrepareManager`` is
  // fully cache-aware (a re-run with bytes already on disk is a
  // verify-only fast path), so this is safe to call on every
  // request the host opts into.
  let prepared = false;
  let artifactDir: string | null = null;
  let files: Record<string, string> | null = null;
  if (options.materializer) {
    // ``client.prepare(...)`` is the explicit caller-driven path,
    // so honor ``prepare_policy === "explicit_only"`` candidates by
    // passing ``mode: 'explicit'`` to the materializer.
    const materialized = await options.materializer.prepare(candidate, { mode: "explicit" });
    prepared = true;
    artifactDir = materialized.artifactDir;
    files = materialized.files;
  }
  return {
    artifactId: safeArtifact.artifact_id ?? safeArtifact.model_id,
    modelId: safeArtifact.model_id,
    capability,
    deliveryMode: "sdk_runtime",
    preparePolicy: candidate.prepare_policy ?? "lazy",
    prepareRequired,
    downloadUrls: safeArtifact.download_urls ?? [],
    requiredFiles: safeArtifact.required_files ?? [],
    digest: safeArtifact.digest ?? null,
    manifestUri: safeArtifact.manifest_uri ?? null,
    prepared,
    artifactDir,
    files,
  };
}

/** Mirror of Python `_local_sdk_runtime_candidate`. Returns the first
 * `locality='local', delivery_mode='sdk_runtime'` candidate, or null. */
function pickLocalSdkRuntimeCandidate(
  plan: RuntimePlanResponse,
): RuntimeCandidatePlan | null {
  for (const candidate of plan.candidates) {
    if (candidate.locality !== "local") continue;
    const deliveryMode = candidate.delivery_mode ?? "sdk_runtime";
    if (deliveryMode !== "sdk_runtime") continue;
    return candidate;
  }
  return null;
}

/** Mirror of Python `_validate_for_prepare`. Throws on any contract
 * violation that would make a real `prepare()` call fail. */
function validatePreparable(candidate: RuntimeCandidatePlan): void {
  const policy = candidate.prepare_policy ?? "lazy";
  if (policy === "disabled") {
    throw new OctomilError(
      "INVALID_INPUT",
      "Candidate's prepare_policy is 'disabled'. The server has marked this artifact " +
        "as ineligible for SDK-side preparation; resolve via a different routing policy.",
    );
  }
  if (!candidate.prepare_required) {
    // prepare_required=false candidates are valid (engine manages its own
    // bytes); the artifact metadata may legitimately be empty.
    return;
  }
  const artifact = candidate.artifact;
  if (!artifact) {
    throw new OctomilError(
      "INVALID_INPUT",
      "Candidate marks prepare_required=true but carries no artifact plan. " +
        "This is a server contract violation; refusing to prepare.",
    );
  }
  if (!artifact.download_urls || artifact.download_urls.length === 0) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Artifact ${JSON.stringify(artifact.artifact_id ?? artifact.model_id)} has no download_urls. ` +
        `Cannot prepare; the planner must emit at least one endpoint.`,
    );
  }
  if (!artifact.digest) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Artifact ${JSON.stringify(artifact.artifact_id ?? artifact.model_id)} has no digest. ` +
        `Refusing to prepare without integrity verification.`,
    );
  }
  const requiredFiles = artifact.required_files ?? [];
  if (requiredFiles.length > 1) {
    throw new OctomilError(
      "INVALID_INPUT",
      `Artifact ${JSON.stringify(artifact.artifact_id ?? artifact.model_id)} lists ` +
        `${requiredFiles.length} required_files but the planner schema in this release ` +
        `only carries a single artifact-level digest. Multi-file artifacts require a ` +
        `per-file manifest_uri (planned in a follow-up PR); refusing to prepare without ` +
        `per-file integrity.`,
    );
  }
  if (requiredFiles.length === 1) {
    const single = requiredFiles[0];
    if (single !== undefined) {
      validateRelativePath(single);
    }
  }
  const artifactId = artifact.artifact_id || artifact.model_id;
  if (!artifactId) {
    throw new OctomilError(
      "INVALID_INPUT",
      "Refusing to prepare artifact with empty artifact_id.",
    );
  }
  if (artifactId.includes("\u0000")) {
    throw new OctomilError(
      "INVALID_INPUT",
      `artifact_id contains a NUL byte: ${JSON.stringify(artifactId)}`,
    );
  }
  // Defensive: block IDs that would require sanitization beyond what a
  // Node consumer might apply when shelling out to `octomil prepare`.
  if (artifactId.includes("/") || artifactId.includes("\\")) {
    // Slashes are allowed at the validation layer in Python (sanitized
    // into the FS key), but flag them so the Node caller knows the
    // server gave a non-trivial id.
  }
}

/** Mirror of Python `_validate_relative_path`. Rejects traversal, dot
 * segments, absolute paths, backslashes, NUL bytes, and empty strings.
 *
 * The empty-string case must be rejected here because callers reach
 * this function from `validatePreparable` only when
 * `required_files.length === 1`. A single-element list whose entry is
 * `""` is *not* the same as an empty list (which represents the
 * single-file artifact case and is handled before validation). An
 * explicit `""` segment in the list would make `_resolve_url` produce
 * `<endpoint>/` and the descriptor's relative path collapse to the
 * directory itself — Python rejects this and Node must too. */
function validateRelativePath(relativePath: string): string {
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

/** Lightweight artifact-shape inspection — symmetrical to Python's
 * `PrepareManager.can_prepare`. Returns true iff `prepareForFacade` would
 * succeed on the given candidate. */
export function canPrepareCandidate(candidate: RuntimeCandidatePlan): boolean {
  if (candidate.locality !== "local") return false;
  const deliveryMode = candidate.delivery_mode ?? "sdk_runtime";
  if (deliveryMode !== "sdk_runtime") return false;
  try {
    validatePreparable(candidate);
    return true;
  } catch {
    return false;
  }
}

export type { RuntimeArtifactPlan };
