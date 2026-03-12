/**
 * Models namespace — model lifecycle management (Layer 0).
 * Matches SDK_FACADE_CONTRACT.md models.status(), models.load(), etc.
 *
 * Provides a unified interface for checking model status, loading/unloading
 * models, listing cached models, and clearing the cache.
 */

import type { FileCache } from "./file-cache.js";
import type { Model } from "./model.js";
import type { CacheInfo, PullOptions, LoadOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Status of a model in the local cache / runtime. */
export type ModelStatus = "not_cached" | "downloading" | "ready" | "error";

/** Information about a cached model on disk. */
export interface CachedModelInfo {
  modelRef: string;
  filePath: string;
  cachedAt: string;
  sizeBytes: number;
}

/**
 * Callback for pulling + loading a model.
 * Provided by the parent OctomilClient so ModelsClient doesn't duplicate logic.
 */
export type PullAndLoadFn = (
  modelRef: string,
  options?: PullOptions & LoadOptions,
) => Promise<Model>;

// ---------------------------------------------------------------------------
// ModelsClient
// ---------------------------------------------------------------------------

export class ModelsClient {
  private readonly cache: FileCache;
  private readonly loadedModels: Map<string, Model>;
  private readonly activeDownloads: Set<string>;
  private readonly errorModels: Set<string>;
  private readonly pullAndLoad: PullAndLoadFn;

  constructor(deps: {
    cache: FileCache;
    loadedModels: Map<string, Model>;
    activeDownloads: Set<string>;
    errorModels: Set<string>;
    pullAndLoad: PullAndLoadFn;
  }) {
    this.cache = deps.cache;
    this.loadedModels = deps.loadedModels;
    this.activeDownloads = deps.activeDownloads;
    this.errorModels = deps.errorModels;
    this.pullAndLoad = deps.pullAndLoad;
  }

  /**
   * Check the current status of a model.
   *
   * Priority: downloading > error > ready (cached on disk) > not_cached
   */
  status(modelRef: string): ModelStatus {
    if (this.activeDownloads.has(modelRef)) return "downloading";
    if (this.errorModels.has(modelRef)) return "error";
    if (this.cache.has(modelRef)) return "ready";
    return "not_cached";
  }

  /**
   * Pull (download if needed) and load a model into memory.
   *
   * Tracks download state and errors for the `status()` method.
   */
  async load(modelRef: string, options?: { version?: string } & LoadOptions): Promise<Model> {
    this.activeDownloads.add(modelRef);
    this.errorModels.delete(modelRef);

    try {
      const model = await this.pullAndLoad(modelRef, options);
      this.loadedModels.set(modelRef, model);
      return model;
    } catch (err) {
      this.errorModels.add(modelRef);
      throw err;
    } finally {
      this.activeDownloads.delete(modelRef);
    }
  }

  /**
   * Dispose and unload a model from the in-memory cache.
   */
  unload(modelRef: string): void {
    const model = this.loadedModels.get(modelRef);
    if (model) {
      model.dispose();
      this.loadedModels.delete(modelRef);
    }
  }

  /**
   * List all models currently cached on disk.
   */
  list(): CachedModelInfo[] {
    return this.cache.list().map((entry: CacheInfo) => ({
      modelRef: entry.modelRef,
      filePath: entry.filePath,
      cachedAt: entry.cachedAt,
      sizeBytes: entry.sizeBytes,
    }));
  }

  /**
   * Remove all models from the on-disk cache.
   *
   * Also disposes any loaded models from memory.
   */
  clearCache(): void {
    const entries = this.cache.list();
    for (const entry of entries) {
      // Dispose from memory if loaded
      const model = this.loadedModels.get(entry.modelRef);
      if (model) {
        model.dispose();
        this.loadedModels.delete(entry.modelRef);
      }
      // Remove from disk cache
      this.cache.remove(entry.modelRef);
    }
  }
}
