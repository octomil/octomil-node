/**
 * LocalFileModelRuntime — wraps a local model file on disk.
 *
 * Delegates actual inference to the engine registry or a provided
 * ModelRuntime. This is the runtime created for BUNDLED and cached
 * MANAGED models.
 */

import type { ModelRuntime } from "../core/model-runtime.js";

export class LocalFileModelRuntime implements ModelRuntime {
  readonly modelId: string;
  readonly filePath: string;
  private delegate: ModelRuntime | null = null;

  constructor(modelId: string, filePath: string) {
    this.modelId = modelId;
    this.filePath = filePath;
  }

  /** Inject the actual engine delegate after construction. */
  setDelegate(runtime: ModelRuntime): void {
    this.delegate = runtime;
  }

  async createSession(
    filePath: string,
    options?: Record<string, unknown>,
  ): Promise<void> {
    if (this.delegate) {
      return this.delegate.createSession(filePath, options);
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
