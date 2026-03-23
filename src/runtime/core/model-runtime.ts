/**
 * ModelRuntime — abstract interface for model execution backends.
 *
 * Allows injecting alternative runtime implementations (e.g. WASM,
 * TFLite, custom engines) while keeping the same Model / OctomilClient API.
 */

export interface ModelRuntime {
  createSession(
    filePath: string,
    options?: Record<string, unknown>,
  ): Promise<void | unknown>;
  run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispose(): void;
}
