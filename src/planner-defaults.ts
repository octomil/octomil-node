/**
 * Planner routing defaults — determines when server-side plan resolution is active.
 *
 * Planner routing is ON by default when `apiKey` or `serverUrl` credentials exist.
 * Previously, planner routing was opt-in via `plannerRouting: true`. This module
 * makes the default deliberate: ON when credentials exist, OFF when they don't.
 *
 * Escape hatches:
 * - `plannerRouting: false` in OctomilFacadeOptions
 * - `OCTOMIL_DISABLE_PLANNER=1` env var
 *
 * Privacy invariant: "private" and "local_only" routing policies NEVER route
 * to cloud regardless of planner state.
 */

/**
 * Resolve whether planner routing should be enabled.
 *
 * Resolution order:
 * 1. `OCTOMIL_DISABLE_PLANNER=1` env var → OFF
 * 2. Explicit `plannerRouting` option → use that value
 * 3. Credentials (apiKey or publishableKey or auth) exist → ON
 * 4. Otherwise → OFF
 */
export function resolvePlannerEnabled(opts: {
  plannerRouting?: boolean;
  apiKey?: string;
  publishableKey?: string;
  hasAuth?: boolean;
}): boolean {
  // Env var escape hatch always wins
  if (typeof process !== "undefined" && process.env) {
    const envDisable = process.env.OCTOMIL_DISABLE_PLANNER?.trim();
    if (envDisable === "1" || envDisable === "true" || envDisable === "yes") {
      return false;
    }
  }

  // Explicit option override
  if (opts.plannerRouting !== undefined) {
    return opts.plannerRouting;
  }

  // Default: ON when credentials exist
  return hasCredentials(opts);
}

function hasCredentials(opts: {
  apiKey?: string;
  publishableKey?: string;
  hasAuth?: boolean;
}): boolean {
  if (opts.apiKey && opts.apiKey.length > 0) return true;
  if (opts.publishableKey && opts.publishableKey.length > 0) return true;
  if (opts.hasAuth) return true;
  return false;
}

/**
 * Whether the given routing policy MUST block cloud routing.
 *
 * "private" and "local_only" policies NEVER route to cloud, regardless of
 * planner state, credentials, or server plan response.
 */
export function isCloudBlocked(routingPolicy?: string): boolean {
  return routingPolicy === "private" || routingPolicy === "local_only";
}

/**
 * Return the default routing policy based on planner state.
 *
 * When planner is enabled, defaults to "auto" (server decides).
 * When disabled, defaults to "local_first" (legacy behavior).
 */
export function defaultRoutingPolicy(plannerEnabled: boolean): string {
  return plannerEnabled ? "auto" : "local_first";
}
