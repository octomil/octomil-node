/**
 * Local runtime lifecycle status types.
 *
 * Provides cache-aware status reporting for the local runner path.
 * These types extend route metadata with artifact/runtime cache information
 * so callers know whether a model was served from cache, required a download,
 * or is unavailable.
 *
 * SECURITY: Never includes prompt, input, output, audio, or file paths.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Cache status values for local artifacts/runtime.
 *
 * - `hit`            — Artifact was found in cache and reused.
 * - `miss`           — Artifact was not cached; download or preparation needed.
 * - `not_applicable` — No local artifact involved (e.g. cloud-only route).
 * - `unavailable`    — Artifact cannot be obtained (no network, model not found).
 */
export type LocalCacheStatus = "hit" | "miss" | "not_applicable" | "unavailable";

/**
 * Status of the local runtime lifecycle for a given request.
 *
 * Emitted alongside route metadata so callers can inspect cache efficiency
 * and diagnose local runtime issues without exposing user content.
 */
export interface LocalLifecycleStatus {
  /** Whether the local runner is currently reachable. */
  runnerAvailable: boolean;
  /** Cache status for the model artifact used in this request. */
  cacheStatus: LocalCacheStatus;
  /** Engine used for local inference (e.g. "llamacpp", "whisper"). Null if cloud. */
  engine: string | null;
  /** Locality of the final execution: "local" or "cloud". */
  locality: "local" | "cloud";
  /** Execution mode: "sdk_runtime" for local CLI runner, "hosted_gateway" for cloud. */
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  /** If fallback was triggered, the reason code. */
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a lifecycle status for a local runner request.
 *
 * Called after the local runner health check and response to populate
 * route metadata with cache-aware telemetry.
 */
export function buildLocalLifecycleStatus(opts: {
  runnerAvailable: boolean;
  cacheStatus: LocalCacheStatus;
  engine?: string | null;
  fallbackReason?: string;
}): LocalLifecycleStatus {
  return {
    runnerAvailable: opts.runnerAvailable,
    cacheStatus: opts.cacheStatus,
    engine: opts.engine ?? null,
    locality: opts.runnerAvailable ? "local" : "cloud",
    mode: opts.runnerAvailable ? "sdk_runtime" : "hosted_gateway",
    fallbackReason: opts.fallbackReason,
  };
}

/**
 * Build a lifecycle status for when the local runner is unavailable.
 *
 * Used to produce an actionable error with telemetry context before
 * throwing RUNTIME_UNAVAILABLE.
 */
export function buildUnavailableStatus(reason: string): LocalLifecycleStatus {
  return {
    runnerAvailable: false,
    cacheStatus: "unavailable",
    engine: null,
    locality: "cloud",
    mode: "hosted_gateway",
    fallbackReason: reason,
  };
}
