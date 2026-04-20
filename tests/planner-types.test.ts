import { describe, it, expect } from "vitest";
import {
  SUPPORTED_POLICIES,
  isSupportedPolicy,
} from "../src/planner/types.js";
import type {
  SupportedPolicy,
  PlannerCapability,
  InstalledRuntime,
  DeviceRuntimeProfile,
  RuntimePlanRequest,
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
  RuntimePlanResponse,
  RuntimeBenchmarkSubmission,
  RuntimeDefaultsResponse,
  RouteMetadata,
} from "../src/planner/types.js";

// ---------------------------------------------------------------------------
// Policy name validation
// ---------------------------------------------------------------------------

describe("SUPPORTED_POLICIES", () => {
  it("contains exactly the 6 supported policy names", () => {
    expect(SUPPORTED_POLICIES).toEqual([
      "private",
      "local_only",
      "local_first",
      "cloud_first",
      "cloud_only",
      "performance_first",
    ]);
  });

  it("does not include quality_first", () => {
    expect(
      (SUPPORTED_POLICIES as readonly string[]).includes("quality_first"),
    ).toBe(false);
  });

  it("has 6 entries", () => {
    expect(SUPPORTED_POLICIES).toHaveLength(6);
  });
});

describe("isSupportedPolicy", () => {
  it.each([
    "private",
    "local_only",
    "local_first",
    "cloud_first",
    "cloud_only",
    "performance_first",
  ] as const)("returns true for %s", (policy) => {
    expect(isSupportedPolicy(policy)).toBe(true);
  });

  it("returns false for quality_first", () => {
    expect(isSupportedPolicy("quality_first")).toBe(false);
  });

  it("returns false for unknown strings", () => {
    expect(isSupportedPolicy("banana")).toBe(false);
    expect(isSupportedPolicy("")).toBe(false);
    expect(isSupportedPolicy("LOCAL_FIRST")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type structure tests — ensure types are correctly shaped
// ---------------------------------------------------------------------------

describe("type shapes", () => {
  it("InstalledRuntime has required and optional fields", () => {
    const runtime: InstalledRuntime = {
      engine: "onnxruntime-node",
    };
    expect(runtime.engine).toBe("onnxruntime-node");
    expect(runtime.version).toBeUndefined();
    expect(runtime.available).toBeUndefined();
    expect(runtime.accelerator).toBeUndefined();
    expect(runtime.metadata).toBeUndefined();

    const full: InstalledRuntime = {
      engine: "llama.cpp",
      version: "b3000",
      available: true,
      accelerator: "metal",
      metadata: { threads: 8 },
    };
    expect(full.engine).toBe("llama.cpp");
    expect(full.version).toBe("b3000");
    expect(full.available).toBe(true);
    expect(full.accelerator).toBe("metal");
    expect(full.metadata).toEqual({ threads: 8 });
  });

  it("DeviceRuntimeProfile has required and optional fields", () => {
    const profile: DeviceRuntimeProfile = {
      sdk: "node",
      sdk_version: "1.2.0",
      platform: "darwin",
      arch: "arm64",
    };
    expect(profile.sdk).toBe("node");
    expect(profile.platform).toBe("darwin");
    expect(profile.os_version).toBeUndefined();
    expect(profile.chip).toBeUndefined();
    expect(profile.ram_total_bytes).toBeUndefined();
    expect(profile.installed_runtimes).toBeUndefined();
  });

  it("RuntimePlanRequest has required and optional fields", () => {
    const request: RuntimePlanRequest = {
      model: "phi-4-mini",
      capability: "chat",
      device: {
        sdk: "node",
        sdk_version: "1.2.0",
        platform: "linux",
        arch: "x64",
      },
    };
    expect(request.model).toBe("phi-4-mini");
    expect(request.capability).toBe("chat");
    expect(request.routing_policy).toBeUndefined();
    expect(request.allow_cloud_fallback).toBeUndefined();
  });

  it("RuntimeCandidatePlan represents local and cloud candidates", () => {
    const local: RuntimeCandidatePlan = {
      locality: "local",
      engine: "llama.cpp",
      priority: 1,
      confidence: 0.95,
      reason: "installed engine matches",
    };
    expect(local.locality).toBe("local");
    expect(local.engine).toBe("llama.cpp");
    expect(local.benchmark_required).toBeUndefined();

    const cloud: RuntimeCandidatePlan = {
      locality: "cloud",
      priority: 2,
      confidence: 0.8,
      reason: "cloud fallback",
      benchmark_required: false,
    };
    expect(cloud.locality).toBe("cloud");
    expect(cloud.engine).toBeUndefined();
  });

  it("RuntimePlanResponse has all expected fields", () => {
    const response: RuntimePlanResponse = {
      model: "phi-4-mini",
      capability: "chat",
      policy: "local_first",
      candidates: [
        {
          locality: "local",
          engine: "onnxruntime-node",
          priority: 1,
          confidence: 0.9,
          reason: "engine available",
        },
      ],
      fallback_candidates: [
        {
          locality: "cloud",
          priority: 2,
          confidence: 0.7,
          reason: "cloud fallback",
        },
      ],
      plan_ttl_seconds: 604800,
      server_generated_at: "2026-04-20T00:00:00Z",
    };
    expect(response.candidates).toHaveLength(1);
    expect(response.fallback_candidates).toHaveLength(1);
    expect(response.policy).toBe("local_first");
  });

  it("RuntimeBenchmarkSubmission has all expected fields", () => {
    const submission: RuntimeBenchmarkSubmission = {
      source: "planner",
      model: "phi-4-mini",
      capability: "chat",
      engine: "llama.cpp",
      device: {
        sdk: "node",
        sdk_version: "1.2.0",
        platform: "darwin",
        arch: "arm64",
      },
      success: true,
      tokens_per_second: 42.5,
      ttft_ms: 150,
    };
    expect(submission.source).toBe("planner");
    expect(submission.success).toBe(true);
  });

  it("RuntimeDefaultsResponse has all expected fields", () => {
    const defaults: RuntimeDefaultsResponse = {
      default_policy: "local_first",
      plan_ttl_seconds: 604800,
      benchmark_ttl_seconds: 1209600,
      supported_policies: ["local_first", "cloud_first", "private"],
      supported_capabilities: ["chat", "embeddings"],
    };
    expect(defaults.default_policy).toBe("local_first");
    expect(defaults.supported_policies).toContain("local_first");
  });

  it("RouteMetadata has all expected fields", () => {
    const meta: RouteMetadata = {
      locality: "on_device",
      engine: "llama.cpp",
      planner_source: "server",
      fallback_used: false,
      reason: "local engine available and preferred",
    };
    expect(meta.locality).toBe("on_device");
    expect(meta.engine).toBe("llama.cpp");
    expect(meta.planner_source).toBe("server");
    expect(meta.fallback_used).toBe(false);

    const cloudMeta: RouteMetadata = {
      locality: "cloud",
      planner_source: "cache",
      fallback_used: true,
      reason: "local engine unavailable, using cloud fallback",
    };
    expect(cloudMeta.locality).toBe("cloud");
    expect(cloudMeta.engine).toBeUndefined();
  });

  it("PlannerCapability covers the 5 supported capabilities", () => {
    const caps: PlannerCapability[] = [
      "chat",
      "responses",
      "embeddings",
      "transcription",
      "audio",
    ];
    expect(caps).toHaveLength(5);
  });

  it("SupportedPolicy type matches SUPPORTED_POLICIES values", () => {
    // This is a compile-time check that the type and array are in sync.
    // If SUPPORTED_POLICIES is updated without updating SupportedPolicy, this fails at compile.
    const policies: SupportedPolicy[] = [...SUPPORTED_POLICIES];
    expect(policies).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Policy constraint tests — business logic validation
// ---------------------------------------------------------------------------

describe("policy constraints", () => {
  it("private policy: plan response should have no cloud candidates", () => {
    const privatePlan: RuntimePlanResponse = {
      model: "phi-4-mini",
      capability: "chat",
      policy: "private",
      candidates: [
        {
          locality: "local",
          engine: "llama.cpp",
          priority: 1,
          confidence: 0.95,
          reason: "private policy — local only",
        },
      ],
      fallback_candidates: [],
      plan_ttl_seconds: 604800,
      server_generated_at: "2026-04-20T00:00:00Z",
    };

    const cloudCandidates = privatePlan.candidates.filter(
      (c) => c.locality === "cloud",
    );
    const cloudFallbacks = privatePlan.fallback_candidates.filter(
      (c) => c.locality === "cloud",
    );
    expect(cloudCandidates).toHaveLength(0);
    expect(cloudFallbacks).toHaveLength(0);
  });

  it("cloud_only policy: plan response should have no local candidates", () => {
    const cloudOnlyPlan: RuntimePlanResponse = {
      model: "gpt-4o",
      capability: "chat",
      policy: "cloud_only",
      candidates: [
        {
          locality: "cloud",
          priority: 1,
          confidence: 1.0,
          reason: "cloud_only policy",
        },
      ],
      fallback_candidates: [],
      plan_ttl_seconds: 604800,
      server_generated_at: "2026-04-20T00:00:00Z",
    };

    const localCandidates = cloudOnlyPlan.candidates.filter(
      (c) => c.locality === "local",
    );
    const localFallbacks = cloudOnlyPlan.fallback_candidates.filter(
      (c) => c.locality === "local",
    );
    expect(localCandidates).toHaveLength(0);
    expect(localFallbacks).toHaveLength(0);
  });

  it("local_first policy: local candidates should have higher priority than cloud", () => {
    const plan: RuntimePlanResponse = {
      model: "phi-4-mini",
      capability: "chat",
      policy: "local_first",
      candidates: [
        {
          locality: "local",
          engine: "llama.cpp",
          priority: 1,
          confidence: 0.9,
          reason: "local preferred",
        },
      ],
      fallback_candidates: [
        {
          locality: "cloud",
          priority: 2,
          confidence: 0.8,
          reason: "cloud fallback",
        },
      ],
      plan_ttl_seconds: 604800,
      server_generated_at: "2026-04-20T00:00:00Z",
    };

    const localPriority = plan.candidates[0]!.priority;
    const cloudPriority = plan.fallback_candidates[0]!.priority;
    expect(localPriority).toBeLessThan(cloudPriority);
  });
});

// ---------------------------------------------------------------------------
// RuntimeArtifactPlan
// ---------------------------------------------------------------------------

describe("RuntimeArtifactPlan", () => {
  it("has all optional fields", () => {
    const minimal: RuntimeArtifactPlan = {
      model_id: "phi-4-mini",
    };
    expect(minimal.model_id).toBe("phi-4-mini");
    expect(minimal.artifact_id).toBeUndefined();
    expect(minimal.format).toBeUndefined();
    expect(minimal.quantization).toBeUndefined();

    const full: RuntimeArtifactPlan = {
      model_id: "phi-4-mini",
      artifact_id: "artifact-123",
      model_version: "v1.0",
      format: "gguf",
      quantization: "q4_k_m",
      uri: "https://r2.octomil.com/models/phi-4-mini.gguf",
      digest: "sha256:abc123",
      size_bytes: 2_000_000_000,
      min_ram_bytes: 4_000_000_000,
    };
    expect(full.format).toBe("gguf");
    expect(full.quantization).toBe("q4_k_m");
  });
});
