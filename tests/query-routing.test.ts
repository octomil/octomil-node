import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PolicyClient,
  QueryRouter,
  assignTiers,
} from "../src/query-routing.js";
import type { ModelInfo, RoutingPolicy } from "../src/query-routing.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SERVER_POLICY: Omit<RoutingPolicy, "fetched_at" | "etag"> = {
  version: 2,
  thresholds: { fast_max_words: 8, quality_min_words: 40 },
  complex_indicators: ["implement", "refactor", "kubernetes"],
  deterministic_enabled: true,
  ttl_seconds: 1800,
};

const MODELS: Record<string, ModelInfo> = {
  "tiny-1b": { name: "tiny-1b", tier: "fast", paramB: 1, loaded: true },
  "mid-7b": { name: "mid-7b", tier: "balanced", paramB: 7, loaded: true },
  "big-70b": { name: "big-70b", tier: "quality", paramB: 70, loaded: false },
  "big-13b": { name: "big-13b", tier: "quality", paramB: 13, loaded: true },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function policyFilePath(): string {
  return path.join(os.tmpdir(), "octomil_routing_policy.json");
}

function writePolicyToDisk(policy: RoutingPolicy): void {
  fs.writeFileSync(policyFilePath(), JSON.stringify(policy), "utf-8");
}

function readPolicyFromDisk(): RoutingPolicy {
  return JSON.parse(
    fs.readFileSync(policyFilePath(), "utf-8"),
  ) as RoutingPolicy;
}

// ---------------------------------------------------------------------------
// PolicyClient tests
// ---------------------------------------------------------------------------

describe("PolicyClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // Clean disk cache before each test.
    try {
      fs.unlinkSync(policyFilePath());
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.unlinkSync(policyFilePath());
    } catch {
      // ignore
    }
  });

  // -----------------------------------------------------------------------
  // Server fetch
  // -----------------------------------------------------------------------

  it("fetches policy from server and caches to disk", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(SERVER_POLICY), {
        status: 200,
        headers: { etag: '"v2"' },
      }),
    );

    const client = new PolicyClient("https://api.octomil.com", "test-key");
    const policy = await client.getPolicy();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(policy.version).toBe(2);
    expect(policy.thresholds.fast_max_words).toBe(8);
    expect(policy.etag).toBe('"v2"');
    expect(policy.fetched_at).toBeGreaterThan(0);

    // Verify disk cache.
    const diskPolicy = readPolicyFromDisk();
    expect(diskPolicy.version).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Disk caching — write + read
  // -----------------------------------------------------------------------

  it("reads policy from disk cache when within TTL", async () => {
    const cached: RoutingPolicy = {
      ...SERVER_POLICY,
      fetched_at: Date.now(),
      etag: '"v2"',
    };
    writePolicyToDisk(cached);

    // Server should not be called.
    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(policy.version).toBe(2);
  });

  // -----------------------------------------------------------------------
  // ETag 304 handling
  // -----------------------------------------------------------------------

  it("sends If-None-Match and handles 304", async () => {
    // Seed with an expired disk policy.
    const expired: RoutingPolicy = {
      ...SERVER_POLICY,
      fetched_at: Date.now() - 2 * 3600 * 1000, // expired
      etag: '"v2"',
    };
    writePolicyToDisk(expired);

    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 304 }));

    const client = new PolicyClient("https://api.octomil.com", "key");
    const policy = await client.getPolicy();

    // Should have sent If-None-Match header.
    const callArgs = fetchSpy.mock.calls[0]!;
    const reqInit = callArgs[1] as RequestInit;
    const headers = reqInit.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"v2"');

    // Policy should be refreshed (new fetched_at) but same version.
    expect(policy.version).toBe(2);
    expect(policy.fetched_at).toBeGreaterThan(expired.fetched_at);
  });

  // -----------------------------------------------------------------------
  // Default policy fallback
  // -----------------------------------------------------------------------

  it("returns default policy when server unreachable and no disk cache", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network down"));

    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    expect(policy.version).toBe(1);
    expect(policy.thresholds.fast_max_words).toBe(10);
    expect(policy.complex_indicators).toContain("implement");
    expect(policy.fetched_at).toBeGreaterThan(0);
  });

  it("returns expired disk policy when server is unreachable", async () => {
    const expired: RoutingPolicy = {
      ...SERVER_POLICY,
      fetched_at: Date.now() - 2 * 3600 * 1000,
      etag: '"v2"',
    };
    writePolicyToDisk(expired);
    fetchSpy.mockRejectedValueOnce(new Error("Network down"));

    const client = new PolicyClient("https://api.octomil.com");
    const policy = await client.getPolicy();

    // Should return the expired disk policy, not the default.
    expect(policy.version).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// QueryRouter tests
// ---------------------------------------------------------------------------

describe("QueryRouter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    // Provide the default policy without network.
    fetchSpy.mockRejectedValue(new Error("No network in test"));
    try {
      fs.unlinkSync(policyFilePath());
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Tier routing
  // -----------------------------------------------------------------------

  it("routes short queries to fast tier", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([
      { role: "user", content: "Hi there" },
    ]);

    expect(decision.tier).toBe("fast");
    expect(decision.modelName).toBe("tiny-1b");
    expect(decision.strategy).toBe("word_count");
  });

  it("routes long queries to quality tier", async () => {
    const router = new QueryRouter(MODELS);
    const longMsg = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const decision = await router.route([{ role: "user", content: longMsg }]);

    expect(decision.tier).toBe("quality");
    expect(decision.strategy).toBe("word_count");
  });

  it("routes medium queries to balanced tier", async () => {
    const router = new QueryRouter(MODELS);
    // 20 words — between fast_max_words (10) and quality_min_words (50).
    const mediumMsg = Array.from({ length: 20 }, (_, i) => `word${i}`).join(
      " ",
    );
    const decision = await router.route([{ role: "user", content: mediumMsg }]);

    expect(decision.tier).toBe("balanced");
    expect(decision.modelName).toBe("mid-7b");
  });

  it("routes complex keyword queries to quality tier", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([
      {
        role: "user",
        content: "Please implement a kubernetes deployment for this service",
      },
    ]);

    expect(decision.tier).toBe("quality");
    expect(decision.strategy).toBe("complex_indicators");
    // Should prefer the loaded quality model.
    expect(decision.modelName).toBe("big-13b");
  });

  // -----------------------------------------------------------------------
  // Deterministic detection
  // -----------------------------------------------------------------------

  it("detects arithmetic '2+2' as deterministic", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([{ role: "user", content: "2+2" }]);

    expect(decision.strategy).toBe("deterministic");
    expect(decision.deterministicResult).toBeDefined();
    expect(decision.deterministicResult!.answer).toBe("4");
    expect(decision.deterministicResult!.method).toBe("arithmetic");
    expect(decision.deterministicResult!.confidence).toBe(1.0);
    expect(decision.tier).toBe("fast");
  });

  it("detects 'sqrt(16)' as deterministic", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([
      { role: "user", content: "sqrt(16)" },
    ]);

    expect(decision.deterministicResult).toBeDefined();
    expect(decision.deterministicResult!.answer).toBe("4");
  });

  it("detects 'what is 10 * 3?' as deterministic", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([
      { role: "user", content: "what is 10 * 3?" },
    ]);

    expect(decision.deterministicResult).toBeDefined();
    expect(decision.deterministicResult!.answer).toBe("30");
  });

  it("respects enableDeterministic=false", async () => {
    const router = new QueryRouter(MODELS, { enableDeterministic: false });
    const decision = await router.route([{ role: "user", content: "2+2" }]);

    expect(decision.deterministicResult).toBeUndefined();
    expect(decision.strategy).not.toBe("deterministic");
  });

  // -----------------------------------------------------------------------
  // Fallback chain
  // -----------------------------------------------------------------------

  it("builds a fallback chain excluding the primary model", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([{ role: "user", content: "Hi" }]);

    // Primary is tiny-1b (fast). Fallback chain should contain all others.
    expect(decision.fallbackChain).not.toContain("tiny-1b");
    expect(decision.fallbackChain.length).toBe(3);
    // Quality models first, then balanced.
    expect(decision.fallbackChain[0]).toBe("big-13b");
    expect(decision.fallbackChain[1]).toBe("big-70b");
    expect(decision.fallbackChain[2]).toBe("mid-7b");
  });

  it("getFallback returns the first fallback model", async () => {
    const router = new QueryRouter(MODELS);
    const fallback = router.getFallback("tiny-1b");
    expect(fallback).toBe("big-13b");
  });

  it("getFallback returns null when model is not found", async () => {
    const singleModel: Record<string, ModelInfo> = {
      "only-one": { name: "only-one", tier: "fast", paramB: 1, loaded: true },
    };
    const router = new QueryRouter(singleModel);
    const fallback = router.getFallback("only-one");
    expect(fallback).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Complexity score
  // -----------------------------------------------------------------------

  it("returns a numeric complexity score between 0 and 1", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([
      {
        role: "user",
        content: "Explain how to implement a transformer model step by step",
      },
    ]);

    expect(decision.complexityScore).toBeGreaterThanOrEqual(0);
    expect(decision.complexityScore).toBeLessThanOrEqual(1);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it("handles empty messages array", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([]);

    // No user message → empty text → 0 words → fast tier.
    expect(decision.tier).toBe("fast");
  });

  it("uses the last user message for routing", async () => {
    const router = new QueryRouter(MODELS);
    const decision = await router.route([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
      { role: "user", content: "2+2" },
    ]);

    expect(decision.strategy).toBe("deterministic");
    expect(decision.deterministicResult!.answer).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// assignTiers tests
// ---------------------------------------------------------------------------

describe("assignTiers", () => {
  it("groups models into correct tiers", () => {
    const tiers = assignTiers(MODELS);

    expect(tiers["fast"]).toHaveLength(1);
    expect(tiers["fast"]![0]!.name).toBe("tiny-1b");
    expect(tiers["balanced"]).toHaveLength(1);
    expect(tiers["quality"]).toHaveLength(2);
  });

  it("sorts within tier by paramB ascending", () => {
    const tiers = assignTiers(MODELS);
    const quality = tiers["quality"]!;

    expect(quality[0]!.name).toBe("big-13b");
    expect(quality[1]!.name).toBe("big-70b");
  });

  it("handles empty models", () => {
    const tiers = assignTiers({});

    expect(tiers["fast"]).toHaveLength(0);
    expect(tiers["balanced"]).toHaveLength(0);
    expect(tiers["quality"]).toHaveLength(0);
  });
});
