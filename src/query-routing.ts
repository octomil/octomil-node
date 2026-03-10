/**
 * Policy-based query routing client.
 *
 * Fetches a routing policy from the server, caches it to disk, and applies
 * simple word-count + keyword thresholds locally for offline-capable routing.
 */

import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Routing policy returned by GET /api/v1/route/policy. */
export interface RoutingPolicy {
  version: number;
  thresholds: { fast_max_words: number; quality_min_words: number };
  complex_indicators: string[];
  deterministic_enabled: boolean;
  ttl_seconds: number;
  fetched_at: number;
  etag: string;
}

/** Descriptor for an available model. */
export interface ModelInfo {
  name: string;
  tier: "fast" | "balanced" | "quality";
  paramB?: number;
  loaded?: boolean;
}

/** Result of routing a query to a model. */
export interface QueryRoutingDecision {
  modelName: string;
  complexityScore: number;
  tier: string;
  strategy: string;
  fallbackChain: string[];
  deterministicResult?: { answer: string; method: string; confidence: number };
}

// ---------------------------------------------------------------------------
// Default policy (embedded)
// ---------------------------------------------------------------------------

const DEFAULT_POLICY: RoutingPolicy = {
  version: 1,
  thresholds: { fast_max_words: 10, quality_min_words: 50 },
  complex_indicators: [
    "implement",
    "refactor",
    "debug",
    "analyze",
    "compare",
    "step by step",
    "prove",
    "derive",
    "calculate",
    "algorithm",
    "kubernetes",
    "docker",
    "neural network",
    "transformer",
  ],
  deterministic_enabled: true,
  ttl_seconds: 3600,
  fetched_at: 0,
  etag: "",
};

// ---------------------------------------------------------------------------
// Deterministic detection
// ---------------------------------------------------------------------------

/** Simple arithmetic patterns we can evaluate without an LLM. */
const ARITHMETIC_RE =
  /^\s*(?:what\s+is\s+)?(\d+(?:\.\d+)?)\s*([+\-*/])\s*(\d+(?:\.\d+)?)\s*[?]?\s*$/i;
const SQRT_RE = /^\s*(?:what\s+is\s+)?sqrt\((\d+(?:\.\d+)?)\)\s*[?]?\s*$/i;

function tryDeterministic(
  text: string,
): { answer: string; method: string; confidence: number } | undefined {
  let m = ARITHMETIC_RE.exec(text);
  if (m) {
    const a = parseFloat(m[1]!);
    const op = m[2]!;
    const b = parseFloat(m[3]!);
    let result: number;
    switch (op) {
      case "+":
        result = a + b;
        break;
      case "-":
        result = a - b;
        break;
      case "*":
        result = a * b;
        break;
      case "/":
        result = b === 0 ? NaN : a / b;
        break;
      default:
        return undefined;
    }
    if (Number.isNaN(result)) return undefined;
    return {
      answer: String(result),
      method: "arithmetic",
      confidence: 1.0,
    };
  }

  m = SQRT_RE.exec(text);
  if (m) {
    const n = parseFloat(m[1]!);
    const result = Math.sqrt(n);
    return {
      answer: String(result),
      method: "arithmetic",
      confidence: 1.0,
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// PolicyClient
// ---------------------------------------------------------------------------

/** Fetches, caches, and serves the routing policy. */
export class PolicyClient {
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private policy: RoutingPolicy | null = null;

  constructor(apiBase: string, apiKey?: string) {
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.apiKey = apiKey;
  }

  /** Return the current policy — from memory, disk, server, or default. */
  async getPolicy(): Promise<RoutingPolicy> {
    // 1. In-memory cache (within TTL).
    if (this.policy && !this.isExpired(this.policy)) {
      return this.policy;
    }

    // 2. Try disk cache first (may still be valid).
    const diskPolicy = await this.loadFromDisk();
    if (diskPolicy && !this.isExpired(diskPolicy)) {
      this.policy = diskPolicy;
      return diskPolicy;
    }

    // 3. Fetch from server with ETag if available.
    const etag = diskPolicy?.etag ?? this.policy?.etag ?? "";
    try {
      const fetched = await this.fetchFromServer(etag);
      if (fetched === null) {
        // 304 — disk/memory policy is still valid; refresh TTL.
        const refreshed: RoutingPolicy = {
          ...(diskPolicy ?? this.policy ?? DEFAULT_POLICY),
          fetched_at: Date.now(),
        };
        this.policy = refreshed;
        await this.saveToDisk(refreshed);
        return refreshed;
      }
      this.policy = fetched;
      await this.saveToDisk(fetched);
      return fetched;
    } catch {
      // Server unreachable — fall back to expired cache or default.
      if (diskPolicy) {
        this.policy = diskPolicy;
        return diskPolicy;
      }
      if (this.policy) {
        return this.policy;
      }
      return { ...DEFAULT_POLICY, fetched_at: Date.now() };
    }
  }

  // -----------------------------------------------------------------------
  // Server fetch
  // -----------------------------------------------------------------------

  private async fetchFromServer(etag: string): Promise<RoutingPolicy | null> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    if (etag) {
      headers["If-None-Match"] = etag;
    }

    const response = await fetch(`${this.apiBase}/api/v1/route/policy`, {
      method: "GET",
      headers,
    });

    if (response.status === 304) {
      return null;
    }

    if (!response.ok) {
      throw new OctomilError(
        `Policy fetch failed: HTTP ${response.status}`,
        "NETWORK_ERROR",
      );
    }

    const body = (await response.json()) as Omit<
      RoutingPolicy,
      "fetched_at" | "etag"
    >;
    const responseEtag = response.headers.get("etag") ?? "";

    return {
      ...body,
      fetched_at: Date.now(),
      etag: responseEtag,
    } as RoutingPolicy;
  }

  // -----------------------------------------------------------------------
  // TTL check
  // -----------------------------------------------------------------------

  private isExpired(policy: RoutingPolicy): boolean {
    return Date.now() - policy.fetched_at > policy.ttl_seconds * 1000;
  }

  // -----------------------------------------------------------------------
  // Disk cache
  // -----------------------------------------------------------------------

  private async getCachePath(): Promise<string> {
    const path = await import("node:path");
    const os = await import("node:os");
    return path.join(os.tmpdir(), "octomil_routing_policy.json");
  }

  private async loadFromDisk(): Promise<RoutingPolicy | null> {
    try {
      const fs = await import("node:fs/promises");
      const filePath = await this.getCachePath();
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as RoutingPolicy;
    } catch {
      return null;
    }
  }

  private async saveToDisk(policy: RoutingPolicy): Promise<void> {
    try {
      const fs = await import("node:fs/promises");
      const filePath = await this.getCachePath();
      await fs.writeFile(filePath, JSON.stringify(policy), "utf-8");
    } catch {
      // Ignore filesystem errors.
    }
  }
}

// ---------------------------------------------------------------------------
// QueryRouter
// ---------------------------------------------------------------------------

/** Assign tiers to models based on paramB, falling back to the declared tier. */
export function assignTiers(
  models: Record<string, ModelInfo>,
): Record<string, ModelInfo[]> {
  const tiers: Record<string, ModelInfo[]> = {
    fast: [],
    balanced: [],
    quality: [],
  };
  for (const info of Object.values(models)) {
    const tier = info.tier;
    tiers[tier]?.push(info);
  }
  // Sort each tier by paramB ascending (smaller → faster).
  for (const list of Object.values(tiers)) {
    list.sort((a, b) => (a.paramB ?? 0) - (b.paramB ?? 0));
  }
  return tiers;
}

/** Routes user queries to the best-fit model using a server-provided policy. */
export class QueryRouter {
  private readonly models: Record<string, ModelInfo>;
  private readonly policyClient: PolicyClient;
  private readonly enableDeterministic: boolean;
  private readonly tiers: Record<string, ModelInfo[]>;

  constructor(
    models: Record<string, ModelInfo>,
    options?: {
      apiBase?: string;
      apiKey?: string;
      enableDeterministic?: boolean;
    },
  ) {
    this.models = models;
    this.enableDeterministic = options?.enableDeterministic ?? true;
    this.policyClient = new PolicyClient(
      options?.apiBase ?? "https://api.octomil.com",
      options?.apiKey,
    );
    this.tiers = assignTiers(models);
  }

  /**
   * Route a conversation to a model.
   *
   * Extracts the last user message, scores complexity, and picks a tier.
   */
  async route(
    messages: Array<{ role: string; content: string }>,
  ): Promise<QueryRoutingDecision> {
    const policy = await this.policyClient.getPolicy();
    const lastUser =
      messages
        .slice()
        .reverse()
        .find((m) => m.role === "user")?.content ?? "";

    // Deterministic short-circuit.
    if (this.enableDeterministic && policy.deterministic_enabled) {
      const det = tryDeterministic(lastUser);
      if (det) {
        const fastModel = this.pickModel("fast");
        return {
          modelName: fastModel,
          complexityScore: 0,
          tier: "fast",
          strategy: "deterministic",
          fallbackChain: this.buildFallbackChain(fastModel),
          deterministicResult: det,
        };
      }
    }

    // Complexity scoring: word count + keyword matching.
    const words = lastUser.split(/\s+/).filter((w) => w.length > 0);
    const wordCount = words.length;
    const lowerText = lastUser.toLowerCase();

    let indicatorHits = 0;
    for (const indicator of policy.complex_indicators) {
      if (lowerText.includes(indicator.toLowerCase())) {
        indicatorHits++;
      }
    }

    // Score: base from word count, boosted by indicator hits.
    const wordScore = Math.min(
      wordCount / policy.thresholds.quality_min_words,
      1.0,
    );
    const indicatorScore = Math.min(indicatorHits / 3, 1.0);
    const complexityScore = Math.min(
      wordScore * 0.6 + indicatorScore * 0.4,
      1.0,
    );

    // Tier selection — complex indicators override word-count thresholds.
    let tier: string;
    let strategy: string;
    if (indicatorHits > 0) {
      tier = "quality";
      strategy = "complex_indicators";
    } else if (wordCount <= policy.thresholds.fast_max_words) {
      tier = "fast";
      strategy = "word_count";
    } else if (wordCount >= policy.thresholds.quality_min_words) {
      tier = "quality";
      strategy = "word_count";
    } else {
      tier = "balanced";
      strategy = "word_count";
    }

    const modelName = this.pickModel(tier);
    return {
      modelName,
      complexityScore: Math.round(complexityScore * 100) / 100,
      tier,
      strategy,
      fallbackChain: this.buildFallbackChain(modelName),
    };
  }

  /** Get the next fallback model when `failedModel` is unavailable. */
  getFallback(failedModel: string): string | null {
    const chain = this.buildFallbackChain(failedModel);
    return chain.length > 0 ? chain[0] ?? null : null;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private pickModel(tier: string): string {
    // Prefer a loaded model in the requested tier.
    const candidates = this.tiers[tier] ?? [];
    const loaded = candidates.find((m) => m.loaded);
    if (loaded) return loaded.name;
    if (candidates.length > 0) return candidates[0]!.name;

    // Fallback: any loaded model, or first model overall.
    const allModels = Object.values(this.models);
    const anyLoaded = allModels.find((m) => m.loaded);
    if (anyLoaded) return anyLoaded.name;
    return allModels[0]?.name ?? "unknown";
  }

  private buildFallbackChain(primaryModel: string): string[] {
    const tierOrder = ["quality", "balanced", "fast"];
    const chain: string[] = [];
    for (const tier of tierOrder) {
      for (const model of this.tiers[tier] ?? []) {
        if (model.name !== primaryModel) {
          chain.push(model.name);
        }
      }
    }
    return chain;
  }
}
