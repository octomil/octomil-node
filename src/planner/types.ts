/**
 * Runtime planner types — mirrors the server contract and Python SDK schemas.
 *
 * These types describe the request/response shapes for the server-side runtime
 * planner API (POST /api/v2/runtime/plan, POST /api/v2/runtime/benchmarks,
 * GET /api/v2/runtime/defaults).
 */

// ---------------------------------------------------------------------------
// Supported routing policy names
// ---------------------------------------------------------------------------

/**
 * Canonical routing policy names.
 *
 * - `private` / `local_only` — never contact the cloud
 * - `local_first` — prefer local, fall back to cloud
 * - `cloud_first` — prefer cloud, fall back to local
 * - `cloud_only` — never use local engines
 * - `performance_first` — pick whichever is fastest (local or cloud)
 *
 * `quality_first` is intentionally excluded.
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

/** Execution details for a routed request. */
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

/** Cache status for a downloaded artifact. */
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

/** Canonical planner source values. */
export type PlannerSource = "server" | "cache" | "offline";

/** Canonical set for runtime validation. */
export const CANONICAL_PLANNER_SOURCES: ReadonlySet<PlannerSource> = new Set([
  "server",
  "cache",
  "offline",
]);

const PLANNER_SOURCE_ALIASES: Record<string, PlannerSource> = {
  local_default: "offline",
  server_plan: "server",
  cached: "cache",
  fallback: "offline",
  none: "offline",
  local_benchmark: "offline",
};

/**
 * Normalize a planner source string to a canonical value.
 *
 * Canonical values: "server", "cache", "offline".
 * Deprecated aliases are mapped to their canonical equivalent.
 * Unknown values pass through as-is (cast to PlannerSource).
 */
export function normalizePlannerSource(source: string): PlannerSource {
  return PLANNER_SOURCE_ALIASES[source] ?? (source as PlannerSource);
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
