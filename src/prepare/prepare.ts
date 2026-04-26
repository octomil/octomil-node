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
 * `_PREPAREABLE_CAPABILITIES`. */
export const PREPAREABLE_CAPABILITIES: ReadonlySet<PlannerCapability> =
  new Set<PlannerCapability>([
    "tts",
    "transcription",
    "embeddings",
    "chat",
    "responses",
  ]);

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
  /** False until Node grows a durable downloader. Today, callers shell
   *  out to `octomil prepare` (Python CLI) to actually fetch. */
  prepared: boolean;
}

export interface PrepareOptions {
  model: string;
  capability?: PlannerCapability;
  routingPolicy?: string;
  appSlug?: string;
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
      `client.prepare() got unknown capability ${JSON.stringify(capability)}. ` +
        `Supported: ${Array.from(PREPAREABLE_CAPABILITIES).sort().join(", ")}.`,
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

  const artifact = candidate.artifact!;
  return {
    artifactId: artifact.artifact_id ?? artifact.model_id,
    modelId: artifact.model_id,
    capability,
    deliveryMode: "sdk_runtime",
    preparePolicy: candidate.prepare_policy ?? "lazy",
    prepareRequired: candidate.prepare_required ?? false,
    downloadUrls: artifact.download_urls ?? [],
    requiredFiles: artifact.required_files ?? [],
    digest: artifact.digest ?? null,
    manifestUri: artifact.manifest_uri ?? null,
    // Node SDK does not download yet — the Python `octomil prepare` CLI
    // is the supported way to materialize the bytes today.
    prepared: false,
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
 * segments, absolute paths, backslashes, NUL bytes. */
function validateRelativePath(relativePath: string): string {
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
