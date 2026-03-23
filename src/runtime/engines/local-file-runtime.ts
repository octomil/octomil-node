/**
 * LocalFileModelRuntime — wraps local model files on disk.
 *
 * Supports multi-resource packages via ResourceBindings. The primary
 * weights file is available via `filePath`, and additional resources
 * (projector, tokenizer, etc.) are accessible through `resourceBindings`.
 *
 * Delegates actual inference to the engine registry or a provided
 * ModelRuntime. This is the runtime created for BUNDLED and cached
 * MANAGED models.
 */

import type { ModelRuntime } from "../core/model-runtime.js";
import type { ResourceBindings } from "../../manifest/types.js";
import { ArtifactResourceKind } from "../../_generated/artifact_resource_kind.js";

export class LocalFileModelRuntime implements ModelRuntime {
  readonly modelId: string;
  readonly filePath: string;
  readonly resourceBindings: ResourceBindings;
  private delegate: ModelRuntime | null = null;

  constructor(
    modelId: string,
    filePath: string,
    resourceBindings?: ResourceBindings,
  ) {
    this.modelId = modelId;
    this.filePath = filePath;
    this.resourceBindings = resourceBindings ?? {
      [ArtifactResourceKind.Weights]: filePath,
    };
  }

  /** Inject the actual engine delegate after construction. */
  setDelegate(runtime: ModelRuntime): void {
    this.delegate = runtime;
  }

  /**
   * Get a resource file path by kind.
   * Returns undefined if the resource is not present in bindings.
   */
  getResource(kind: ArtifactResourceKind): string | undefined {
    return this.resourceBindings[kind];
  }

  /**
   * Get a required resource file path by kind.
   * Throws if the resource is not present.
   */
  requireResource(kind: ArtifactResourceKind): string {
    const path = this.resourceBindings[kind];
    if (!path) {
      throw new Error(
        `LocalFileModelRuntime(${this.modelId}): missing required resource: ${kind}`,
      );
    }
    return path;
  }

  /**
   * Check if this runtime has a specific resource kind.
   */
  hasResource(kind: ArtifactResourceKind): boolean {
    return this.resourceBindings[kind] !== undefined;
  }

  async createSession(
    filePath: string,
    options?: Record<string, unknown>,
  ): Promise<void> {
    if (this.delegate) {
      await this.delegate.createSession(filePath, options);
      return;
    }
    // No delegate — the file path is stored for later resolution.
  }

  async run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.delegate) {
      throw new Error(
        `LocalFileModelRuntime(${this.modelId}): no delegate engine set`,
      );
    }
    return this.delegate.run(input);
  }

  dispose(): void {
    this.delegate?.dispose();
    this.delegate = null;
  }
}
