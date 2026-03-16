/**
 * ModelRef — a reference to a model by catalog ID or by capability.
 *
 * Used throughout the manifest, catalog, audio, and text namespaces to
 * resolve models without hard-coding identifiers.
 */

import { ModelCapability } from "./_generated/model_capability.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelRefById {
  readonly type: "id";
  readonly id: string;
}

export interface ModelRefByCapability {
  readonly type: "capability";
  readonly capability: ModelCapability;
}

export type ModelRef = ModelRefById | ModelRefByCapability;

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export const ModelRef = {
  id(id: string): ModelRefById {
    return { type: "id", id };
  },
  capability(capability: ModelCapability): ModelRefByCapability {
    return { type: "capability", capability };
  },
} as const;
