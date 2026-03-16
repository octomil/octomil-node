/**
 * Auth configuration for the top-level configure() flow and publishable key auth.
 *
 * SilentAuthConfig covers the configure() path.
 * PublishableKeyAuth is a standalone auth class that validates keys, enforces
 * publishable-key-safe scopes, and produces appropriate HTTP headers.
 */

import { Scope } from "./_generated/scope.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PublishableKeyEnvironment = "test" | "live";

export type SilentAuthConfig =
  | { type: "publishable_key"; key: string }
  | { type: "bootstrap_token"; token: string }
  | { type: "anonymous"; appId: string };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PREFIXES = ["oct_pub_test_", "oct_pub_live_"] as const;

/**
 * Validates that a publishable key has an environment-scoped prefix.
 * Throws if the key does not start with `oct_pub_test_` or `oct_pub_live_`.
 */
export function validatePublishableKey(key: string): void {
  if (!VALID_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(
      "Publishable key must start with 'oct_pub_test_' or 'oct_pub_live_'",
    );
  }
}

/**
 * Extracts the environment ("test" or "live") from a publishable key.
 * Returns null if the key does not have a recognized prefix.
 */
export function getPublishableKeyEnvironment(
  key: string,
): PublishableKeyEnvironment | null {
  if (key.startsWith("oct_pub_test_")) return "test";
  if (key.startsWith("oct_pub_live_")) return "live";
  return null;
}

// ---------------------------------------------------------------------------
// PublishableKeyAuth
// ---------------------------------------------------------------------------

/**
 * The set of scopes that publishable keys are allowed to use.
 * These are client-safe operations that do not grant write access to
 * organization resources.
 */
const PUBLISHABLE_KEY_ALLOWED_SCOPES: ReadonlySet<Scope> = new Set([
  Scope.DevicesRegister,
  Scope.DevicesHeartbeat,
  Scope.TelemetryWrite,
  Scope.ModelsRead,
]);

/**
 * Publishable-key authentication for client-side / on-device SDK usage.
 *
 * - Validates the key starts with `oct_pub_test_` or `oct_pub_live_`.
 * - Restricts operations to a safe subset of scopes (devices:register,
 *   devices:heartbeat, telemetry:write, models:read).
 * - Produces the `X-API-Key` header expected by the Octomil API.
 */
export class PublishableKeyAuth {
  readonly type = "publishable_key" as const;
  readonly key: string;
  readonly environment: PublishableKeyEnvironment;

  constructor(key: string) {
    validatePublishableKey(key);
    const env = getPublishableKeyEnvironment(key);
    if (!env) {
      // Should be unreachable after validatePublishableKey, but guards the type.
      throw new Error("Unable to determine publishable key environment");
    }
    this.key = key;
    this.environment = env;
  }

  /**
   * Returns the set of scopes this publishable key is allowed to use.
   */
  get allowedScopes(): ReadonlySet<Scope> {
    return PUBLISHABLE_KEY_ALLOWED_SCOPES;
  }

  /**
   * Returns true if the given scope is permitted for publishable key auth.
   */
  hasScope(scope: Scope): boolean {
    return PUBLISHABLE_KEY_ALLOWED_SCOPES.has(scope);
  }

  /**
   * Asserts that the given scope is permitted. Throws if not.
   */
  requireScope(scope: Scope): void {
    if (!this.hasScope(scope)) {
      throw new Error(
        `Scope '${scope}' is not allowed for publishable key auth. ` +
          `Allowed scopes: ${[...PUBLISHABLE_KEY_ALLOWED_SCOPES].join(", ")}`,
      );
    }
  }

  /**
   * Returns HTTP headers for authenticating requests with this publishable key.
   */
  headers(): Record<string, string> {
    return { "X-API-Key": this.key };
  }
}
