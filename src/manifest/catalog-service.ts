/**
 * ModelCatalogService — bootstraps AppManifest entries into runtime registry
 * and resolves runtimes by capability or ModelRef at call time.
 */

import { ModelCapability } from "../_generated/model_capability.js";
import { DeliveryMode } from "../_generated/delivery_mode.js";
import type { ModelRuntime } from "../runtime/core/model-runtime.js";
import { LocalFileModelRuntime } from "../runtime/engines/local-file-runtime.js";
import { ModelReadinessManager } from "./readiness-manager.js";
import type { AppManifest, AppModelEntry } from "./types.js";
import type { ModelRef } from "../model-ref.js";
import { OctomilError } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CloudRuntimeFactory = (modelId: string) => ModelRuntime;

export interface CatalogServiceOptions {
  manifest: AppManifest;
  readiness: ModelReadinessManager;
  cloudRuntimeFactory?: CloudRuntimeFactory;
}

// ---------------------------------------------------------------------------
// ModelCatalogService
// ---------------------------------------------------------------------------

export class ModelCatalogService {
  private readonly manifest: AppManifest;
  private readonly readiness: ModelReadinessManager;
  private readonly cloudRuntimeFactory: CloudRuntimeFactory | undefined;

  /** Resolved runtimes keyed by capability. */
  private readonly capabilityRuntimes = new Map<ModelCapability, ModelRuntime>();

  /** Resolved runtimes keyed by model ID. */
  private readonly idRuntimes = new Map<string, ModelRuntime>();

  constructor(options: CatalogServiceOptions) {
    this.manifest = options.manifest;
    this.readiness = options.readiness;
    this.cloudRuntimeFactory = options.cloudRuntimeFactory;
  }

  /** Walk every manifest entry and prepare its runtime. */
  async bootstrap(): Promise<void> {
    for (const entry of this.manifest.models) {
      try {
        this.bootstrapEntry(entry);
      } catch (err) {
        if (entry.required) throw err;
        // Optional entries are silently skipped on error
      }
    }
  }

  /** Resolve a ModelRuntime for a given capability. */
  runtimeForCapability(capability: ModelCapability): ModelRuntime | undefined {
    return this.capabilityRuntimes.get(capability);
  }

  /** Resolve a ModelRuntime for a ModelRef. */
  runtimeForRef(ref: ModelRef): ModelRuntime | undefined {
    switch (ref.type) {
      case "id":
        return this.idRuntimes.get(ref.id);
      case "capability":
        return this.capabilityRuntimes.get(ref.capability);
    }
  }

  /** Called when a managed model download completes. */
  onModelReady(entry: AppModelEntry, filePath: string): void {
    const runtime = new LocalFileModelRuntime(entry.id, filePath);
    this.capabilityRuntimes.set(entry.capability, runtime);
    this.idRuntimes.set(entry.id, runtime);
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private bootstrapEntry(entry: AppModelEntry): void {
    switch (entry.delivery) {
      case DeliveryMode.Bundled:
        this.bootstrapBundled(entry);
        break;
      case DeliveryMode.Managed:
        this.bootstrapManaged(entry);
        break;
      case DeliveryMode.Cloud:
        this.bootstrapCloud(entry);
        break;
    }
  }

  private bootstrapBundled(entry: AppModelEntry): void {
    if (!entry.bundledPath) {
      throw new OctomilError(
        "INVALID_INPUT",
        `Bundled model '${entry.id}' has no bundledPath`,
      );
    }
    const runtime = new LocalFileModelRuntime(entry.id, entry.bundledPath);
    this.capabilityRuntimes.set(entry.capability, runtime);
    this.idRuntimes.set(entry.id, runtime);
  }

  private bootstrapManaged(entry: AppModelEntry): void {
    // Queue for background download
    this.readiness.enqueue(entry);

    // Listen for completion
    this.readiness.onUpdate((event) => {
      if (event.type === "ready" && event.modelId === entry.id) {
        this.onModelReady(entry, event.filePath);
      }
    });
  }

  private bootstrapCloud(entry: AppModelEntry): void {
    if (!this.cloudRuntimeFactory) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        `No cloud runtime factory for model '${entry.id}'`,
      );
    }
    const runtime = this.cloudRuntimeFactory(entry.id);
    this.capabilityRuntimes.set(entry.capability, runtime);
    this.idRuntimes.set(entry.id, runtime);
  }
}
