/**
 * Manifest types — AppManifest, AppModelEntry, AppRoutingPolicy.
 *
 * Pure data types with no runtime or engine dependencies.
 */

import { ModelCapability } from "../_generated/model_capability.js";
import { DeliveryMode } from "../_generated/delivery_mode.js";
import { RoutingPolicy } from "../_generated/routing_policy.js";

// ---------------------------------------------------------------------------
// AppRoutingPolicy (re-export RoutingPolicy with a manifest-local alias)
// ---------------------------------------------------------------------------

export type AppRoutingPolicy = RoutingPolicy;
export { RoutingPolicy as AppRoutingPolicyEnum } from "../_generated/routing_policy.js";

// ---------------------------------------------------------------------------
// AppModelEntry
// ---------------------------------------------------------------------------

export interface AppModelEntry {
  readonly id: string;
  readonly capability: ModelCapability;
  readonly delivery: DeliveryMode;
  readonly routingPolicy?: AppRoutingPolicy;
  /** Relative or absolute path for bundled models. */
  readonly bundledPath?: string;
  readonly required: boolean;
}

/** Derive the effective routing policy from an explicit override or the delivery mode. */
export function effectiveRoutingPolicy(entry: AppModelEntry): RoutingPolicy {
  if (entry.routingPolicy) return entry.routingPolicy;
  switch (entry.delivery) {
    case DeliveryMode.Bundled:
      return RoutingPolicy.LocalOnly;
    case DeliveryMode.Managed:
      return RoutingPolicy.LocalFirst;
    case DeliveryMode.Cloud:
      return RoutingPolicy.CloudOnly;
  }
}

// ---------------------------------------------------------------------------
// AppManifest
// ---------------------------------------------------------------------------

export interface AppManifest {
  readonly models: readonly AppModelEntry[];
}

/** Find the first entry matching a capability. */
export function manifestEntryForCapability(
  manifest: AppManifest,
  capability: ModelCapability,
): AppModelEntry | undefined {
  return manifest.models.find((e) => e.capability === capability);
}

/** Find an entry by model ID. */
export function manifestEntryForModelId(
  manifest: AppManifest,
  id: string,
): AppModelEntry | undefined {
  return manifest.models.find((e) => e.id === id);
}
