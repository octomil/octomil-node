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
import type { PrepareManager } from "./prepare-manager.js";

/** Capabilities `prepare()` understands. Mirror of Python
 * `_PREPAREABLE_CAPABILITIES`.
 *
 * `tts` and `transcription` are wired today: both dispatch paths
 * thread the prepared `model_dir` into their backend (the local
 * runner reads it as `warm_model_dir` in the request body, so the
 * runner can short-circuit re-loading and pin the prepared bytes
 * to the inference call). `embedding`, `chat`, and `responses` will
 * be added one at a time as their backends learn to consume the
 * prepared directory; accepting them here without that wiring
 * would let the SDK download bytes the next inference call ignores. */
export const PREPAREABLE_CAPABILITIES: ReadonlySet<PlannerCapability> =
  new Set<PlannerCapability>(["tts", "transcription"]);

/** Result of a successful `prepare(...)` call.
 *
 * `prepared = true` means the bytes are on disk under `modelDir` with
 * the planner's digest verified end-to-end. `prepared = false` is the
 * planner-introspection-only path: the candidate validated, but no
 * PrepareManager was configured so the SDK did not materialize bytes.
 *
 * The dispatch layer uses `modelDir` to thread the prepared artifact
 * into the engine's `model_dir` argument, which is the bridge between
 * `prepare()` and `audio.speech.create(...)` — the same bridge Python
 * uses, so apps can preload artifacts in a build step and the runtime
 * picks them up at first call.
 */
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
  /** True only when a {@link PrepareManager} downloaded + materialized
   *  the bytes successfully and the digest was verified. */
  prepared: boolean;
  /** Runtime layout root (engine `model_dir`). Set when `prepared=true`. */
  modelDir: string | null;
  /** Absolute path to the primary file inside `modelDir`. */
  primaryPath: string | null;
  /** Whether this prepare hit the durable cache (`true`) or actually
   *  downloaded fresh bytes (`false`). Mirrors Python's idempotency
   *  contract — a second prepare is a no-op other than a digest
   *  re-verification. */
  cacheHit: boolean;
  /** Planner-resolved app slug when the input was an `@app/<slug>/...`
   *  ref or an `app=` was passed; preserved on the outcome so callers
   *  can confirm the planner kept the app identity end-to-end. */
  appSlug: string | null;
  /** Effective routing policy after app/policy resolution. */
  routingPolicy: string | null;
}

export interface PrepareOptions {
  model: string;
  capability?: PlannerCapability;
  /** Routing policy override — `"private"`, `"local_only"`,
   *  `"local_first"`, `"cloud_first"`, `"cloud_only"`,
   *  `"performance_first"`. Mirrors Python `client.prepare(..., policy=)`.
   *  When set, the planner uses this in place of any policy resolved
   *  from the app row. */
  policy?: string;
  /** App slug or `@app/<slug>` reference. Mirrors Python
   *  `client.prepare(..., app=)`. The planner uses this to resolve the
   *  app identity even when the model field is a non-app ref. */
  app?: string;
  /** @deprecated Use `policy`. Retained for callers built against an
   *  earlier alpha. */
  routingPolicy?: string;
  /** @deprecated Use `app`. */
  appSlug?: string;
  /** Optional pre-built PrepareManager. When omitted, prepare returns
   *  planner-introspection only (`prepared=false`). When provided, the
   *  SDK materializes the artifact end-to-end (`prepared=true`). */
  prepareManager?: PrepareManager | null;
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
  const effectivePolicy = options.policy ?? options.routingPolicy;
  const effectiveAppSlug = appSlugFromOption(options.app) ?? options.appSlug;
  const plan = await plannerClient.fetchPlan({
    model: options.model,
    capability,
    routing_policy: effectivePolicy,
    app_slug: effectiveAppSlug,
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

  const planAppSlug =
    typeof plan.app_resolution?.app_slug === "string"
      ? plan.app_resolution.app_slug
      : (options.appSlug ?? null);
  const planPolicy =
    typeof plan.app_resolution?.routing_policy === "string"
      ? plan.app_resolution.routing_policy
      : (plan.policy ?? options.routingPolicy ?? null);

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
      modelDir: null,
      primaryPath: null,
      cacheHit: false,
      appSlug: planAppSlug,
      routingPolicy: planPolicy,
    };
  }
  // Type-narrowed by the early return above + the validator's guarantee.
  const safeArtifact: RuntimeArtifactPlan = artifact!;
  let prepared = false;
  let modelDir: string | null = null;
  let primaryPath: string | null = null;
  let cacheHit = false;
  if (options.prepareManager) {
    const result = await options.prepareManager.prepare(candidate);
    prepared = true;
    modelDir = result.modelDir;
    primaryPath = result.primaryPath;
    cacheHit = result.cacheHit;
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
    // `prepared` flips to true only when a PrepareManager was passed in
    // and the artifact materialized end-to-end. The legacy
    // planner-introspection mode keeps `prepared=false` so existing
    // callers continue to see the same shape.
    prepared,
    modelDir,
    primaryPath,
    cacheHit,
    appSlug: planAppSlug,
    routingPolicy: planPolicy,
  };
}

/** Coerce an `app` option (slug or `@app/<slug>` ref) into a bare slug. */
function appSlugFromOption(app?: string): string | undefined {
  if (!app) return undefined;
  const trimmed = app.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("@app/")) {
    // `@app/<slug>` or `@app/<slug>/<capability>` — return the second
    // path segment, never anything past the slug.
    const tail = trimmed.slice("@app/".length).split("/")[0] ?? "";
    return tail || undefined;
  }
  return trimmed;
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
