/**
 * HTTP client for the server-side runtime planner API.
 *
 * Endpoints:
 *   POST /api/v2/runtime/plan       — fetch a runtime plan
 *   POST /api/v2/runtime/benchmarks — submit benchmark telemetry
 *   GET  /api/v2/runtime/defaults   — fetch server defaults
 *
 * All methods are best-effort: failures are logged, never thrown to the caller.
 * This matches the Python SDK's RuntimePlannerClient behaviour.
 */

import type {
  RuntimePlanRequest,
  RuntimePlanResponse,
  RuntimeCandidatePlan,
  RuntimeArtifactPlan,
  RuntimeBenchmarkSubmission,
  RuntimeDefaultsResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://api.octomil.com";
const PLAN_PATH = "/api/v2/runtime/plan";
const BENCHMARK_PATH = "/api/v2/runtime/benchmarks";
const DEFAULTS_PATH = "/api/v2/runtime/defaults";
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RuntimePlannerClientOptions {
  /** Base URL of the Octomil API server. */
  baseUrl?: string;
  /** API key (server key or publishable key). */
  apiKey?: string;
  /** Request timeout in milliseconds. @default 10_000 */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class RuntimePlannerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(options: RuntimePlannerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Fetch a runtime plan from the server.
   *
   * Returns `null` on any failure (network, parse, timeout).
   */
  async fetchPlan(
    request: RuntimePlanRequest,
  ): Promise<RuntimePlanResponse | null> {
    try {
      const response = await this.post(PLAN_PATH, request);
      if (!response) return null;

      const data = (await response.json()) as Record<string, unknown>;
      return parsePlanResponse(data);
    } catch {
      return null;
    }
  }

  /**
   * Submit benchmark telemetry to the server.
   *
   * Returns `true` on success, `false` on any failure.
   */
  async submitBenchmark(
    submission: RuntimeBenchmarkSubmission,
  ): Promise<boolean> {
    try {
      const response = await this.post(BENCHMARK_PATH, submission);
      return response !== null;
    } catch {
      return false;
    }
  }

  /**
   * Fetch server-side defaults (supported policies, TTLs, etc.).
   *
   * Returns `null` on any failure.
   */
  async fetchDefaults(): Promise<RuntimeDefaultsResponse | null> {
    try {
      const response = await this.get(DEFAULTS_PATH);
      if (!response) return null;

      return (await response.json()) as RuntimeDefaultsResponse;
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Internal HTTP helpers
  // -----------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      return response;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async get(path: string): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers(),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      return response;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Response parsing (mirrors Python SDK's _parse_plan_response)
// ---------------------------------------------------------------------------

function parseArtifact(
  data: Record<string, unknown> | undefined | null,
): RuntimeArtifactPlan | undefined {
  if (!data || typeof data !== "object") return undefined;

  return {
    model_id: String(data.model_id ?? ""),
    artifact_id: data.artifact_id != null ? String(data.artifact_id) : undefined,
    model_version:
      data.model_version != null ? String(data.model_version) : undefined,
    format: data.format != null ? String(data.format) : undefined,
    quantization:
      data.quantization != null ? String(data.quantization) : undefined,
    uri: data.uri != null ? String(data.uri) : undefined,
    digest: data.digest != null ? String(data.digest) : undefined,
    size_bytes:
      typeof data.size_bytes === "number" ? data.size_bytes : undefined,
    min_ram_bytes:
      typeof data.min_ram_bytes === "number" ? data.min_ram_bytes : undefined,
  };
}

function parseCandidate(data: Record<string, unknown>): RuntimeCandidatePlan {
  return {
    locality: data.locality === "cloud" ? "cloud" : "local",
    engine: data.engine != null ? String(data.engine) : undefined,
    engine_version_constraint:
      data.engine_version_constraint != null
        ? String(data.engine_version_constraint)
        : undefined,
    artifact: parseArtifact(
      data.artifact as Record<string, unknown> | undefined,
    ),
    priority: typeof data.priority === "number" ? data.priority : 0,
    confidence: typeof data.confidence === "number" ? data.confidence : 0,
    reason: String(data.reason ?? ""),
    benchmark_required:
      typeof data.benchmark_required === "boolean"
        ? data.benchmark_required
        : false,
  };
}

/** Parse a raw JSON object into a typed RuntimePlanResponse. */
export function parsePlanResponse(
  data: Record<string, unknown>,
): RuntimePlanResponse {
  const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];
  const rawFallback = Array.isArray(data.fallback_candidates)
    ? data.fallback_candidates
    : [];

  return {
    model: String(data.model ?? ""),
    capability: String(data.capability ?? ""),
    policy: String(data.policy ?? ""),
    candidates: rawCandidates.map((c: Record<string, unknown>) =>
      parseCandidate(c),
    ),
    fallback_candidates: rawFallback.map((c: Record<string, unknown>) =>
      parseCandidate(c),
    ),
    plan_ttl_seconds:
      typeof data.plan_ttl_seconds === "number"
        ? data.plan_ttl_seconds
        : 604_800,
    server_generated_at: String(data.server_generated_at ?? ""),
  };
}
