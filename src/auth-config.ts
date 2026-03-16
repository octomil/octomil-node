/**
 * SilentAuthConfig — auth configuration for the top-level configure() flow.
 *
 * Separate from the existing AuthConfig in types.ts which covers
 * OrgApiKeyAuth / DeviceTokenAuth for the OctomilClient constructor.
 */

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
