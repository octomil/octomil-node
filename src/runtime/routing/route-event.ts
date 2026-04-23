/**
 * Route event types and builder.
 *
 * A RouteEvent is emitted after each inference request completes. It contains
 * routing metadata suitable for telemetry upload — never user content.
 *
 * SECURITY: The FORBIDDEN_FIELDS set is checked before emission to prevent
 * prompt/input/output/audio/file_path leakage into telemetry.
 */

import type { AttemptLoopResult, RouteAttempt } from "./attempt-runner.js";
import { normalizePlannerSource } from "../../planner/types.js";
import type {
  RouteEvent,
  RouteEventAttemptDetail,
} from "../../_generated/runtime_planner_types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { RouteEvent, RouteEventAttemptDetail as AttemptDetail };

// ---------------------------------------------------------------------------
// Forbidden fields — MUST be checked before emission
// ---------------------------------------------------------------------------

/**
 * Keys that must NEVER appear in a RouteEvent or any telemetry payload.
 * Prevents prompt/input/output/audio/file_path leakage into telemetry.
 *
 * Cross-SDK canonical constant name: FORBIDDEN_TELEMETRY_KEYS.
 */
export const FORBIDDEN_TELEMETRY_KEYS = new Set([
  "prompt",
  "input",
  "output",
  "completion",
  "audio",
  "audio_bytes",
  "file_path",
  "text",
  "content",
  "messages",
  "system_prompt",
  "documents",
  "image",
  "image_url",
  "embedding",
  "embeddings",
]);

/** @deprecated Use FORBIDDEN_TELEMETRY_KEYS. */
export const FORBIDDEN_TELEMETRY_FIELDS = FORBIDDEN_TELEMETRY_KEYS;

/**
 * Validate that a route event does not contain any forbidden fields.
 *
 * Recursively checks all keys in the event object. Throws if a forbidden
 * key is found.
 */
export function validateRouteEvent(event: RouteEvent): void {
  const allKeys = collectKeys(event);
  for (const key of allKeys) {
    if (FORBIDDEN_TELEMETRY_KEYS.has(key)) {
      throw new Error(
        `RouteEvent contains forbidden telemetry field: "${key}". ` +
          "Route events must never include user content.",
      );
    }
  }
}

/**
 * Strip any forbidden telemetry keys from an arbitrary key-value map.
 *
 * Returns a new object with forbidden keys removed at any nesting depth.
 * Use this before uploading custom metadata alongside route events.
 */
export function stripForbiddenKeys<T extends object>(obj: T): Partial<T> {
  return scrubValue(obj) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface RouteEventBuilderInput {
  requestId: string;
  capability: string;
  streaming: boolean;
  model: string;
  modelRefKind?: string;
  policy?: string;
  plannerSource?: string;
  planId?: string;
  attemptResult: AttemptLoopResult;
  // Optional ref metadata
  deploymentId?: string;
  experimentId?: string;
  variantId?: string;
  appId?: string;
  appSlug?: string;
}

/**
 * Build a RouteEvent from an AttemptLoopResult and request metadata.
 *
 * Automatically extracts engine, artifact, fallback info from the attempt
 * loop result. Validates the event before returning.
 */
export function buildRouteEvent(input: RouteEventBuilderInput): RouteEvent {
  const { attemptResult } = input;
  const selected = attemptResult.selectedAttempt;

  const locality = selected?.locality ?? null;
  const mode = selected?.mode ?? null;

  const event: RouteEvent = {
    route_id: generateRouteId(),
    request_id: input.requestId,
    plan_id: input.planId,
    capability: input.capability,
    policy: input.policy,
    planner_source: input.plannerSource
      ? normalizePlannerSource(input.plannerSource)
      : undefined,
    final_locality: locality,
    selected_locality: locality,
    final_mode: mode,
    engine: selected?.engine ?? null,
    fallback_used: attemptResult.fallbackUsed,
    fallback_trigger_code: attemptResult.fallbackTrigger?.code,
    fallback_trigger_stage: attemptResult.fallbackTrigger
      ?.stage as RouteEvent["fallback_trigger_stage"],
    candidate_attempts: attemptResult.attempts.length,
    model_ref: input.model,
    model_ref_kind: input.modelRefKind as RouteEvent["model_ref_kind"],
    app_slug: input.appSlug,
    app_id: input.appId,
    deployment_id: input.deploymentId,
    experiment_id: input.experimentId,
    variant_id: input.variantId,
    artifact_id: selected?.artifact?.id ?? undefined,
    cache_status: selected?.artifact?.cache.status as RouteEvent["cache_status"],
  };

  // Build attempt details
  if (attemptResult.attempts.length > 0) {
    event.attempt_details = attemptResult.attempts.map(attemptToDetail);
  }

  validateRouteEvent(event);
  return event;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attemptToDetail(attempt: RouteAttempt): RouteEventAttemptDetail {
  const passed: string[] = [];
  const failed: string[] = [];

  for (const gate of attempt.gate_results) {
    if (gate.status === "passed") {
      passed.push(gate.code);
    } else if (gate.status === "failed") {
      failed.push(gate.code);
    }
  }

  return {
    index: attempt.index,
    locality: attempt.locality,
    mode: attempt.mode,
    engine: attempt.engine,
    status: attempt.status,
    stage: attempt.stage,
    gate_summary: { passed, failed },
    reason_code: attempt.reason.code,
  };
}

function collectKeys(obj: unknown): Set<string> {
  const keys = new Set<string>();
  collectKeysRecursive(obj, keys);
  return keys;
}

function collectKeysRecursive(obj: unknown, keys: Set<string>): void {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      keys.add(k);
      collectKeysRecursive(v, keys);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      collectKeysRecursive(item, keys);
    }
  }
}

function scrubValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item));
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_TELEMETRY_KEYS.has(key)) {
        continue;
      }
      result[key] = scrubValue(child);
    }
    return result;
  }
  return value;
}

function generateRouteId(): string {
  return `route_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
