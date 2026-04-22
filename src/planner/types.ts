/**
 * Runtime planner types — mirrors the server contract and Python SDK schemas.
 *
 * These types describe the request/response shapes for the server-side runtime
 * planner API (POST /api/v2/runtime/plan, POST /api/v2/runtime/benchmarks,
 * GET /api/v2/runtime/defaults).
 *
 * Contract-generated enum types are imported from `_generated/` and re-exported
 * here for convenience. Hand-maintained struct types (interfaces) remain until
 * codegen supports full struct generation.
 */

// ---------------------------------------------------------------------------
// Contract-generated enum re-exports
// ---------------------------------------------------------------------------

export { PlannerSource as ContractPlannerSource } from "../_generated/planner_source.js";
export { CacheStatus as ContractCacheStatus } from "../_generated/cache_status.js";
export { ArtifactCacheStatus as ContractArtifactCacheStatus } from "../_generated/artifact_cache_status.js";
export { ExecutionMode as ContractExecutionMode } from "../_generated/execution_mode.js";
export { RouteLocality as ContractRouteLocality } from "../_generated/route_locality.js";
export { RouteMode as ContractRouteMode } from "../_generated/route_mode.js";
export { ModelRefKind as ContractModelRefKind } from "../_generated/model_ref_kind.js";
export { FallbackTriggerStage as ContractFallbackTriggerStage } from "../_generated/fallback_trigger_stage.js";

import { PlannerSource as GenPlannerSource } from "../_generated/planner_source.js";
import { CacheStatus as GenCacheStatus } from "../_generated/cache_status.js";
import { RouteLocality as GenRouteLocality } from "../_generated/route_locality.js";
import { RouteMode as GenRouteMode } from "../_generated/route_mode.js";

// ---------------------------------------------------------------------------
// Supported routing policy names
// ---------------------------------------------------------------------------

/**
 * Canonical routing policy names.
 *
 * These are validated against the contract-generated RoutingPolicy enum
 * from `_generated/routing_policy.ts`. The generated enum includes "auto"
 * which this SDK does not surface in its supported list.
 */
export const SUPPORTED_POLICIES = [
  "private",
  "local_only",
  "local_first",
  "cloud_first",
  "cloud_only",
  "performance_first",
] as const;

export type SupportedPolicy = (typeof SUPPORTED_POLICIES)[number];

/** Type guard: returns true if `value` is a recognized policy name. */
export function isSupportedPolicy(value: string): value is SupportedPolicy {
  return (SUPPORTED_POLICIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Planner capability — the task type requested
// ---------------------------------------------------------------------------

/**
 * Planner capability — the task type requested.
 * Validated against contract-generated ModelCapability.
 */
export type PlannerCapability =
  | "chat"
  | "responses"
  | "embeddings"
  | "transcription"
  | "audio";

// ---------------------------------------------------------------------------
// Device runtime profile — sent to the server
// ---------------------------------------------------------------------------

/** A locally-installed inference engine detected on this device. */
export interface InstalledRuntime {
  engine: string;
  version?: string;
  available?: boolean;
  accelerator?: string;
  metadata?: Record<string, unknown>;
}

/** Hardware and software profile sent to the server planner endpoint. */
export interface DeviceRuntimeProfile {
  sdk: "python" | "node" | "ios" | "android" | "browser";
  sdk_version: string;
  platform: string;
  arch: string;
  os_version?: string;
  chip?: string;
  ram_total_bytes?: number;
  gpu_core_count?: number;
  accelerators?: string[];
  installed_runtimes?: InstalledRuntime[];
}

// ---------------------------------------------------------------------------
// Plan request
// ---------------------------------------------------------------------------

/** Request body for POST /api/v2/runtime/plan. */
export interface RuntimePlanRequest {
  model: string;
  capability: PlannerCapability;
  routing_policy?: string;
  app_id?: string;
  org_id?: string;
  device: DeviceRuntimeProfile;
  allow_cloud_fallback?: boolean;
}

// ---------------------------------------------------------------------------
// Plan response
// ---------------------------------------------------------------------------

/** Artifact recommendation from the server planner. */
export interface RuntimeArtifactPlan {
  model_id: string;
  artifact_id?: string;
  model_version?: string;
  format?: string;
  quantization?: string;
  uri?: string;
  digest?: string;
  size_bytes?: number;
  min_ram_bytes?: number;
}

/** A single candidate in a runtime plan (local or cloud). */
export interface RuntimeCandidatePlan {
  locality: "local" | "cloud";
  engine?: string;
  engine_version_constraint?: string;
  artifact?: RuntimeArtifactPlan;
  priority: number;
  confidence: number;
  reason: string;
  benchmark_required?: boolean;
}

/** Full plan response from POST /api/v2/runtime/plan. */
export interface RuntimePlanResponse {
  model: string;
  capability: string;
  policy: string;
  candidates: RuntimeCandidatePlan[];
  fallback_candidates: RuntimeCandidatePlan[];
  plan_ttl_seconds: number;
  server_generated_at: string;
}

// ---------------------------------------------------------------------------
// Benchmark submission
// ---------------------------------------------------------------------------

/** Benchmark telemetry submitted to POST /api/v2/runtime/benchmarks. */
export interface RuntimeBenchmarkSubmission {
  source: string;
  model: string;
  capability: string;
  engine: string;
  device: DeviceRuntimeProfile;
  success: boolean;
  tokens_per_second?: number;
  ttft_ms?: number;
  peak_memory_bytes?: number;
  benchmark_tokens?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Defaults response
// ---------------------------------------------------------------------------

/** Response from GET /api/v2/runtime/defaults. */
export interface RuntimeDefaultsResponse {
  default_engines: Record<string, string[]>;
  supported_capabilities: string[];
  supported_policies: string[];
  plan_ttl_seconds: number;
}

// ---------------------------------------------------------------------------
// Route metadata — attached to inference responses
// ---------------------------------------------------------------------------

/**
 * Execution details for a routed request.
 *
 * The `locality` values match ContractRouteLocality (local, cloud).
 * The `mode` values match ContractRouteMode (sdk_runtime, hosted_gateway, external_endpoint).
 * String unions are kept for backward compatibility with consumers that pass literals.
 */
export interface RouteExecution {
  locality: "local" | "cloud";
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  engine: string | null;
}

/** The model reference as requested by the caller. */
export interface RouteModelRequested {
  ref: string;
  kind: "model" | "app" | "deployment" | "alias" | "default" | "unknown";
  capability: string | null;
}

/** Server-resolved model identifiers. */
export interface RouteModelResolved {
  id: string | null;
  slug: string | null;
  version_id: string | null;
  variant_id: string | null;
}

/** Requested + resolved model information. */
export interface RouteModel {
  requested: RouteModelRequested;
  resolved: RouteModelResolved | null;
}

/**
 * Cache status for a downloaded artifact.
 * Status values match ContractCacheStatus.
 */
export interface ArtifactCache {
  status: "hit" | "miss" | "downloaded" | "not_applicable" | "unavailable";
  managed_by: "octomil" | "runtime" | "external" | null;
}

/** Artifact details for a routed request. */
export interface RouteArtifact {
  id: string | null;
  version: string | null;
  format: string | null;
  digest: string | null;
  cache: ArtifactCache;
}

// ---------------------------------------------------------------------------
// Planner source normalization
// ---------------------------------------------------------------------------

/**
 * Canonical planner source values.
 *
 * String union type kept for backward compatibility — validated against
 * the contract-generated ContractPlannerSource enum.
 */
export type PlannerSource = "server" | "cache" | "offline";

/** Canonical set for runtime validation (backed by generated enum values). */
export const CANONICAL_PLANNER_SOURCES: ReadonlySet<PlannerSource> = new Set([
  GenPlannerSource.Server as PlannerSource,
  GenPlannerSource.Cache as PlannerSource,
  GenPlannerSource.Offline as PlannerSource,
]);

const PLANNER_SOURCE_ALIASES: Record<string, PlannerSource> = {
  local_default: GenPlannerSource.Offline as PlannerSource,
  server_plan: GenPlannerSource.Server as PlannerSource,
  cached: GenPlannerSource.Cache as PlannerSource,
  fallback: GenPlannerSource.Offline as PlannerSource,
  none: GenPlannerSource.Offline as PlannerSource,
  local_benchmark: GenPlannerSource.Offline as PlannerSource,
};

/**
 * Normalize a planner source string to a canonical value.
 *
 * Canonical values: "server", "cache", "offline".
 * Deprecated aliases are mapped to their canonical equivalent.
 * Unknown values collapse to "offline" so SDK output boundaries never emit a
 * contract-invalid planner source.
 */
export function normalizePlannerSource(source: string): PlannerSource {
  if (CANONICAL_PLANNER_SOURCES.has(source as PlannerSource)) {
    return source as PlannerSource;
  }
  return PLANNER_SOURCE_ALIASES[source] ?? "offline";
}

/** How the routing plan was obtained. */
export interface PlannerInfo {
  source: PlannerSource;
}

/** Whether a fallback path was used. */
export interface FallbackInfo {
  used: boolean;
}

/** Human-readable reason for the routing decision. */
export interface RouteReason {
  code: string;
  message: string;
}

/**
 * Route metadata describing how a request was routed.
 *
 * Matches the canonical contract shape (JSON wire format) for cross-SDK parity.
 * Public locality values are "local" | "cloud" only — never "on_device".
 */
export interface RouteMetadata {
  status: "selected" | "unavailable";
  execution: RouteExecution | null;
  model: RouteModel;
  artifact: RouteArtifact | null;
  planner: PlannerInfo;
  fallback: FallbackInfo;
  reason: RouteReason;
}

// ---------------------------------------------------------------------------
// Contract adapters
// ---------------------------------------------------------------------------

/**
 * Convert a RouteMetadata to a contract-validated wire-safe object.
 *
 * Ensures all enum-valued fields use canonical contract values.
 * Safe for serialization and cross-SDK interop.
 */
export function toContractRouteMetadata(
  metadata: RouteMetadata,
): Record<string, unknown> {
  return {
    status: metadata.status,
    execution: metadata.execution
      ? {
          locality: metadata.execution.locality,
          mode: metadata.execution.mode,
          engine: metadata.execution.engine,
        }
      : null,
    model: metadata.model,
    artifact: metadata.artifact
      ? {
          ...metadata.artifact,
          cache: {
            ...metadata.artifact.cache,
            status: metadata.artifact.cache.status,
          },
        }
      : null,
    planner: {
      source: normalizePlannerSource(metadata.planner.source),
    },
    fallback: metadata.fallback,
    reason: metadata.reason,
  };
}

/**
 * Convert a RuntimePlanResponse from the server into candidate plans
 * validated against contract enum values.
 */
export function fromContractRuntimePlan(
  response: RuntimePlanResponse,
): {
  candidates: RuntimeCandidatePlan[];
  fallbackCandidates: RuntimeCandidatePlan[];
  policy: string;
  planTtlSeconds: number;
} {
  const validateLocality = (l: string): "local" | "cloud" =>
    l === GenRouteLocality.Local || l === GenRouteLocality.Cloud
      ? (l as "local" | "cloud")
      : "cloud";

  const mapCandidate = (c: RuntimeCandidatePlan): RuntimeCandidatePlan => ({
    ...c,
    locality: validateLocality(c.locality),
  });

  return {
    candidates: response.candidates.map(mapCandidate),
    fallbackCandidates: response.fallback_candidates.map(mapCandidate),
    policy: response.policy,
    planTtlSeconds: response.plan_ttl_seconds,
  };
}
