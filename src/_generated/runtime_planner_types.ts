// Auto-generated from octomil-contracts runtime_planner schemas. Do not edit.

import { ModelRefKind } from "./model_ref_kind.js";

export interface AppResolution {
  app_id: string;
  app_slug?: string | null;
  capability: string;
  routing_policy: string;
  selected_model: string;
  selected_model_variant_id?: string | null;
  selected_model_version?: string | null;
  artifact_candidates?: Array<RuntimeArtifactPlan>;
  preferred_engines?: Array<string>;
  fallback_policy?: string | null;
  plan_ttl_seconds?: number;
}

export interface CandidateGate {
  code: "artifact_verified" | "runtime_available" | "model_loads" | "context_fits" | "modality_supported" | "tool_support" | "min_tokens_per_second" | "max_ttft_ms" | "max_error_rate" | "min_free_memory_bytes" | "min_free_storage_bytes" | "benchmark_fresh";
  required: boolean;
  threshold_number?: number;
  threshold_string?: string;
  window_seconds?: number;
  source: "server" | "sdk" | "runtime";
}

export interface DeviceRuntimeProfile {
  sdk: "python" | "node" | "ios" | "android" | "browser";
  sdk_version: string;
  platform: string;
  arch: string;
  os_version?: string;
  chip?: string;
  ram_total_bytes?: number;
  gpu_core_count?: number;
  accelerators?: Array<string>;
  installed_runtimes?: Array<InstalledRuntime>;
}

export interface InstalledRuntime {
  engine: string;
  version?: string;
  available?: boolean;
  accelerator?: string;
  metadata?: Record<string, unknown>;
}

export interface RouteAttempt {
  index: number;
  locality: "local" | "cloud";
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  engine?: string | null;
  artifact?: AttemptArtifact | null;
  status: "skipped" | "failed" | "selected";
  stage: "policy" | "prepare" | "download" | "verify" | "load" | "benchmark" | "gate" | "inference";
  gate_results?: Array<GateResult>;
  reason: Record<string, unknown>;
}

export interface AttemptArtifact {
  id?: string | null;
  digest?: string | null;
  cache?: Record<string, unknown>;
}

export interface GateResult {
  code: string;
  status: "passed" | "failed" | "unknown" | "not_required";
  observed_number?: number;
  threshold_number?: number;
  reason_code?: string | null;
}

export interface RouteEvent {
  route_id: string;
  request_id: string;
  plan_id?: string | null;
  app_id?: string | null;
  app_slug?: string | null;
  deployment_id?: string | null;
  experiment_id?: string | null;
  variant_id?: string | null;
  capability?: string | null;
  policy?: string | null;
  planner_source?: "server" | "cache" | "offline" | null;
  model_ref?: string | null;
  model_ref_kind?: ModelRefKind | null;
  selected_locality?: "local" | "cloud" | null;
  final_locality?: "local" | "cloud" | null;
  final_mode?: "sdk_runtime" | "hosted_gateway" | "external_endpoint" | null;
  engine?: string | null;
  artifact_id?: string | null;
  cache_status?: "hit" | "miss" | "downloaded" | "not_applicable" | "unavailable" | null;
  fallback_used: boolean;
  fallback_trigger_code?: string | null;
  fallback_trigger_stage?: "policy" | "prepare" | "download" | "verify" | "load" | "benchmark" | "gate" | "inference" | "timeout" | "not_applicable" | null;
  candidate_attempts: number;
  attempt_details?: Array<RouteEventAttemptDetail>;
  ttft_ms?: number | null;
  tokens_per_second?: number | null;
  total_tokens?: number | null;
  duration_ms?: number | null;
}

export interface RouteEventAttemptDetail {
  index: number;
  locality: "local" | "cloud";
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  engine: string | null;
  status: "skipped" | "failed" | "selected";
  stage: "policy" | "prepare" | "download" | "verify" | "load" | "benchmark" | "gate" | "inference";
  gate_summary: Record<string, unknown>;
  reason_code: string;
}

export interface RouteMetadata {
  status: "selected" | "unavailable" | "failed";
  execution?: RouteExecution | null;
  model: RouteModel;
  artifact?: RouteArtifact | null;
  planner: PlannerInfo;
  fallback: FallbackInfo;
  attempts?: Array<RouteAttempt>;
  reason: RouteReason;
}

export interface RouteExecution {
  locality: "local" | "cloud";
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  engine?: string | null;
}

export interface RouteModel {
  requested: RouteModelRequested;
  resolved?: RouteModelResolved | null;
}

export interface RouteModelRequested {
  ref: string;
  kind: ModelRefKind;
  capability?: string | null;
}

export interface RouteModelResolved {
  id?: string | null;
  slug?: string | null;
  version_id?: string | null;
  variant_id?: string | null;
}

export interface RouteArtifact {
  id?: string | null;
  version?: string | null;
  format?: string | null;
  digest?: string | null;
  cache?: ArtifactCache;
}

export interface ArtifactCache {
  status: "hit" | "miss" | "downloaded" | "not_applicable" | "unavailable";
  managed_by?: "octomil" | "runtime" | "external" | null;
}

export interface PlannerInfo {
  source: "server" | "cache" | "offline";
}

export interface FallbackInfo {
  used: boolean;
  from_attempt?: number | null;
  to_attempt?: number | null;
  trigger?: FallbackTrigger | null;
}

export interface FallbackTrigger {
  code: string;
  stage: string;
  message: string;
}

export interface RouteReason {
  code: string;
  message: string;
}

export interface RuntimeBenchmarkSubmission {
  source?: "planner" | "runner" | "manual";
  model: string;
  model_version?: string;
  artifact_digest?: string;
  capability: string;
  engine: string;
  engine_version?: string;
  quantization?: string;
  device: DeviceRuntimeProfile;
  benchmark_tokens?: number;
  ttft_ms?: number;
  tokens_per_second?: number;
  latency_ms?: number;
  peak_memory_bytes?: number;
  success: boolean;
  error_code?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeBenchmarkSubmissionResponse {
  id: string;
  accepted: boolean;
  created_at: string;
}

export interface RuntimeDefaultsResponse {
  default_engines: Record<string, Array<string>>;
  supported_capabilities: Array<string>;
  supported_policies: Array<string>;
  plan_ttl_seconds: number;
}

export interface RuntimePlanRequest {
  model: string;
  capability: "chat" | "responses" | "embeddings" | "transcription" | "audio";
  routing_policy?: "private" | "local_only" | "local_first" | "cloud_first" | "cloud_only" | "performance_first" | "auto";
  app_id?: string;
  app_slug?: string;
  org_id?: string;
  device: DeviceRuntimeProfile;
  allow_cloud_fallback?: boolean;
}

export interface RuntimePlanResponse {
  model: string;
  capability: string;
  policy: string;
  candidates: Array<RuntimeCandidatePlan>;
  fallback_candidates?: Array<RuntimeCandidatePlan>;
  plan_ttl_seconds?: number;
  fallback_allowed?: boolean;
  server_generated_at: string;
  plan_correlation_id?: string;
  app_resolution?: AppResolution | null;
  resolution?: ModelResolution | null;
}

export interface ModelResolution {
  ref_kind: ModelRefKind;
  original_ref: string;
  resolved_model: string;
  deployment_id?: string;
  deployment_key?: string;
  experiment_id?: string;
  variant_id?: string;
  variant_name?: string;
  capability?: string;
  routing_policy?: string;
}

export interface RuntimeCandidatePlan {
  locality: "local" | "cloud";
  engine?: string;
  engine_version_constraint?: string;
  artifact?: RuntimeArtifactPlan;
  priority: number;
  confidence: number;
  reason: string;
  benchmark_required?: boolean;
  gates?: Array<CandidateGate>;
}

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
