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
  default_policy: string;
  plan_ttl_seconds: number;
  benchmark_ttl_seconds: number;
  supported_policies: string[];
  supported_capabilities: string[];
}

// ---------------------------------------------------------------------------
// Route metadata — attached to inference responses
// ---------------------------------------------------------------------------

/**
 * Route metadata describing how a request was routed.
 *
 * Matches the Python SDK's RouteMetadata structure for cross-SDK parity.
 */
export interface RouteMetadata {
  /** Where the inference ran. */
  locality: "on_device" | "cloud";
  /** Engine used for local inference (undefined for cloud). */
  engine?: string;
  /** How the plan was obtained. */
  planner_source: "server" | "cache" | "offline";
  /** Whether the response came from a fallback candidate. */
  fallback_used: boolean;
  /** Human-readable reason for the routing decision. */
  reason: string;
}
