import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Device capability info sent to the routing API. */
export interface DeviceCapabilities {
  platform: "node";
  model: string;
  total_memory_mb: number;
  gpu_available: boolean;
  npu_available: boolean;
  supported_runtimes: string[];
}

/** Routing preference for execution target. */
export type RoutingPreference = "device" | "cloud" | "cheapest" | "fastest";

/** Request body for POST /api/v1/route. */
interface RoutingRequest {
  model_id: string;
  model_params: number;
  model_size_mb: number;
  device_capabilities: DeviceCapabilities;
  prefer: RoutingPreference;
}

/** Fallback target returned by routing. */
export interface RoutingFallbackTarget {
  endpoint: string;
  [key: string]: unknown;
}

/** Response from POST /api/v1/route. */
export interface RoutingDecision {
  id: string;
  target: "device" | "cloud";
  format: string;
  engine: string;
  fallback_target: RoutingFallbackTarget | null;
  /** `true` when loaded from persistent cache (server was unreachable). */
  cached?: boolean;
  /** `true` when this is a synthetic offline-default decision. */
  offline?: boolean;
}

/** Request body for POST /api/v1/inference. */
interface CloudInferenceRequest {
  model_id: string;
  input_data: unknown;
  parameters: Record<string, unknown>;
}

/** Response from POST /api/v1/inference. */
export interface CloudInferenceResponse {
  output: unknown;
  latency_ms: number;
  provider: string;
}

/** Configuration for the routing client. */
export interface RoutingConfig {
  serverUrl: string;
  apiKey: string;
  /** Cache TTL in milliseconds. @default 300_000 (5 minutes) */
  cacheTtlMs?: number;
  /** Routing preference. @default "fastest" */
  prefer?: RoutingPreference;
  /** Directory for persistent cache file. @default os.tmpdir() */
  cachePath?: string;
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  decision: RoutingDecision;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// RoutingClient
// ---------------------------------------------------------------------------

export class RoutingClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly cacheTtlMs: number;
  private readonly prefer: RoutingPreference;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cachePath: string | undefined;

  /** Whether the last `route()` call was answered from offline fallback. */
  lastRouteWasOffline = false;

  constructor(config: RoutingConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.cacheTtlMs = config.cacheTtlMs ?? 300_000;
    this.prefer = config.prefer ?? "fastest";
    this.cachePath = config.cachePath;
  }

  /**
   * Ask the routing API whether to run on-device or in the cloud.
   *
   * Returns a cached decision when available and not expired.
   * On network failure, returns a persistent-cached decision or a synthetic
   * device decision. Never returns `null`.
   */
  async route(
    modelId: string,
    modelParams: number,
    modelSizeMb: number,
    deviceCapabilities: DeviceCapabilities,
  ): Promise<RoutingDecision> {
    this.lastRouteWasOffline = false;

    const cached = this.cache.get(modelId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.decision;
    }

    const body: RoutingRequest = {
      model_id: modelId,
      model_params: modelParams,
      model_size_mb: modelSizeMb,
      device_capabilities: deviceCapabilities,
      prefer: this.prefer,
    };

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/route`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch {
      return this.offlineFallback(modelId);
    }

    if (!response.ok) {
      return this.offlineFallback(modelId);
    }

    const decision = (await response.json()) as RoutingDecision;

    this.cache.set(modelId, {
      decision,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    // Persist to disk for offline fallback.
    await this.persistToDisk(modelId, decision);

    return decision;
  }

  /**
   * Run inference in the cloud via POST /api/v1/inference.
   *
   * Throws on failure so the caller can catch and fall back to local.
   */
  async cloudInfer(
    modelId: string,
    inputData: unknown,
    parameters: Record<string, unknown> = {},
  ): Promise<CloudInferenceResponse> {
    const body: CloudInferenceRequest = {
      model_id: modelId,
      input_data: inputData,
      parameters,
    };

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/inference`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OctomilError(
        `Cloud inference request failed: ${String(err)}`,
        "NETWORK_UNAVAILABLE",
        err,
      );
    }

    if (!response.ok) {
      throw new OctomilError(
        `Cloud inference failed: HTTP ${response.status}`,
        "INFERENCE_FAILED",
      );
    }

    return (await response.json()) as CloudInferenceResponse;
  }

  /** Invalidate all cached routing decisions (in-memory and persistent). */
  async clearCache(): Promise<void> {
    this.cache.clear();
    try {
      const fs = await import("node:fs/promises");
      const filePath = await this.getCacheFilePath();
      await fs.rm(filePath, { force: true });
    } catch {
      // Ignore filesystem errors.
    }
  }

  /** Invalidate the cached routing decision for a specific model. */
  async invalidate(modelId: string): Promise<void> {
    this.cache.delete(modelId);
    const entries = await this.loadPersistentCache();
    delete entries[modelId];
    await this.savePersistentCache(entries);
  }

  // -----------------------------------------------------------------------
  // Offline fallback
  // -----------------------------------------------------------------------

  private offlineFallback(modelId: string): RoutingDecision {
    this.lastRouteWasOffline = true;

    // Try persistent cache (synchronous read to avoid complexity).
    const entries = this.loadPersistentCacheSync();
    const persisted = entries[modelId];
    if (persisted) {
      return { ...persisted, cached: true, offline: false };
    }

    // No cache — synthetic device decision.
    return {
      id: `offline-${modelId}`,
      target: "device",
      format: "onnx",
      engine: "onnxruntime-node",
      fallback_target: null,
      cached: false,
      offline: true,
    };
  }

  // -----------------------------------------------------------------------
  // Persistent cache (filesystem)
  // -----------------------------------------------------------------------

  private async getCacheFilePath(): Promise<string> {
    const path = await import("node:path");
    if (this.cachePath) {
      return path.join(this.cachePath, "octomil_routing_cache.json");
    }
    const os = await import("node:os");
    return path.join(os.tmpdir(), "octomil_routing_cache.json");
  }

  private getCacheFilePathSync(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    if (this.cachePath) {
      return path.join(this.cachePath, "octomil_routing_cache.json");
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require("node:os") as typeof import("node:os");
    return path.join(os.tmpdir(), "octomil_routing_cache.json");
  }

  private async persistToDisk(
    modelId: string,
    decision: RoutingDecision,
  ): Promise<void> {
    const entries = await this.loadPersistentCache();
    entries[modelId] = decision;
    await this.savePersistentCache(entries);
  }

  private async loadPersistentCache(): Promise<
    Record<string, RoutingDecision>
  > {
    try {
      const fs = await import("node:fs/promises");
      const filePath = await this.getCacheFilePath();
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as Record<string, RoutingDecision>;
    } catch {
      return {};
    }
  }

  private loadPersistentCacheSync(): Record<string, RoutingDecision> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const filePath = this.getCacheFilePathSync();
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as Record<string, RoutingDecision>;
    } catch {
      return {};
    }
  }

  private async savePersistentCache(
    entries: Record<string, RoutingDecision>,
  ): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      const filePath = await this.getCacheFilePath();
      await fs.writeFile(filePath, JSON.stringify(entries), "utf-8");
    } catch {
      // Ignore filesystem errors.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect device capabilities in a Node.js environment. */
export async function detectDeviceCapabilities(): Promise<DeviceCapabilities> {
  const os = await import("node:os");
  const totalMemoryMb = Math.round(os.totalmem() / (1024 * 1024));

  return {
    platform: "node",
    model: `${os.type()} ${os.arch()} ${os.release()}`,
    total_memory_mb: totalMemoryMb,
    gpu_available: false, // Conservative default — can't reliably detect GPU from Node
    npu_available: false,
    supported_runtimes: ["onnxruntime-node"],
  };
}
