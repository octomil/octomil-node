/**
 * ModelReadinessManager — tracks download/readiness state for managed models.
 *
 * Provides isReady(), awaitReady(), and an EventEmitter-style callback for
 * progress/completion/failure events.
 */

import type { AppModelEntry } from "./types.js";
import { DeliveryMode } from "../_generated/delivery_mode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReadinessEvent =
  | { type: "progress"; modelId: string; fraction: number }
  | { type: "ready"; modelId: string; filePath: string }
  | { type: "failed"; modelId: string; error: Error };

export type ReadinessListener = (event: ReadinessEvent) => void;

// ---------------------------------------------------------------------------
// ModelReadinessManager
// ---------------------------------------------------------------------------

export class ModelReadinessManager {
  private readonly readyModels = new Map<string, string>(); // modelId -> filePath
  private readonly pendingResolvers = new Map<
    string,
    Array<{ resolve: (filePath: string) => void; reject: (err: Error) => void }>
  >();
  private readonly listeners: ReadinessListener[] = [];
  private readonly activeEntries = new Map<string, AppModelEntry>();

  /** Subscribe to readiness events. */
  onUpdate(listener: ReadinessListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Queue a managed model entry for background download. */
  enqueue(entry: AppModelEntry): void {
    if (entry.delivery !== DeliveryMode.Managed) return;
    this.activeEntries.set(entry.id, entry);
  }

  /** Check if a specific model ID is ready. */
  isReady(modelId: string): boolean {
    return this.readyModels.has(modelId);
  }

  /** Wait until a specific model ID is ready. Returns the file path. */
  awaitReady(modelId: string): Promise<string> {
    const existing = this.readyModels.get(modelId);
    if (existing) return Promise.resolve(existing);

    return new Promise<string>((resolve, reject) => {
      const waiters = this.pendingResolvers.get(modelId) ?? [];
      waiters.push({ resolve, reject });
      this.pendingResolvers.set(modelId, waiters);
    });
  }

  /** Get the entry queued for a given model ID. */
  getEntry(modelId: string): AppModelEntry | undefined {
    return this.activeEntries.get(modelId);
  }

  // -----------------------------------------------------------------------
  // Internal: called by catalog service or download orchestrator
  // -----------------------------------------------------------------------

  /** @internal Mark a model as ready with its file path. */
  _markReady(modelId: string, filePath: string): void {
    this.readyModels.set(modelId, filePath);
    this.activeEntries.delete(modelId);

    this.emit({ type: "ready", modelId, filePath });

    const waiters = this.pendingResolvers.get(modelId);
    if (waiters) {
      this.pendingResolvers.delete(modelId);
      for (const w of waiters) w.resolve(filePath);
    }
  }

  /** @internal Report download progress. */
  _reportProgress(modelId: string, fraction: number): void {
    this.emit({ type: "progress", modelId, fraction });
  }

  /** @internal Mark a model download as failed. */
  _markFailed(modelId: string, error: Error): void {
    this.activeEntries.delete(modelId);

    this.emit({ type: "failed", modelId, error });

    const waiters = this.pendingResolvers.get(modelId);
    if (waiters) {
      this.pendingResolvers.delete(modelId);
      for (const w of waiters) w.reject(error);
    }
  }

  private emit(event: ReadinessEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener errors are swallowed
      }
    }
  }
}
