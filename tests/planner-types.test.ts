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
  RouteExecution,
  RouteModelRequested,
  RouteModelResolved,
  RouteModel,
  ArtifactCache,
  RouteArtifact,
  PlannerInfo,
  FallbackInfo,
  RouteReason,
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

  it("RuntimeDefaultsResponse has contract-backed fields", () => {
    const defaults: RuntimeDefaultsResponse = {
      default_engines: { chat: ["llama.cpp", "onnxruntime-node"], embeddings: ["onnxruntime-node"] },
      supported_capabilities: ["chat", "embeddings"],
      supported_policies: ["local_first", "cloud_first", "private"],
      plan_ttl_seconds: 604800,
    };
    expect(defaults.default_engines).toHaveProperty("chat");
    expect(defaults.supported_policies).toContain("local_first");
    expect(defaults.supported_capabilities).toContain("chat");
    expect(defaults.plan_ttl_seconds).toBe(604800);
    // Contract does NOT include default_policy or benchmark_ttl_seconds
    expect(defaults).not.toHaveProperty("default_policy");
    expect(defaults).not.toHaveProperty("benchmark_ttl_seconds");
  });

  it("RouteMetadata has nested contract-backed shape", () => {
    const meta: RouteMetadata = {
      status: "selected",
      execution: {
        locality: "local",
        mode: "sdk_runtime",
        engine: "llama.cpp",
      },
      model: {
        requested: { ref: "phi-4-mini", kind: "model", capability: "chat" },
        resolved: { id: "model-123", slug: "phi-4-mini", version_id: "v1", variant_id: null },
      },
      artifact: {
        id: "artifact-abc",
        version: "v1.0",
        format: "gguf",
        digest: "sha256:abc123",
        cache: { status: "hit", managed_by: "octomil" },
      },
      planner: { source: "server" },
      fallback: { used: false },
      reason: { code: "engine_available", message: "local engine available and preferred" },
    };
    expect(meta.status).toBe("selected");
    expect(meta.execution?.locality).toBe("local");
    expect(meta.execution?.mode).toBe("sdk_runtime");
    expect(meta.execution?.engine).toBe("llama.cpp");
    expect(meta.model.requested.ref).toBe("phi-4-mini");
    expect(meta.planner.source).toBe("server");
    expect(meta.fallback.used).toBe(false);
    expect(meta.reason.code).toBe("engine_available");

    const cloudMeta: RouteMetadata = {
      status: "selected",
      execution: {
        locality: "cloud",
        mode: "hosted_gateway",
        engine: null,
      },
      model: {
        requested: { ref: "gpt-4o", kind: "model", capability: "chat" },
        resolved: null,
      },
      artifact: null,
      planner: { source: "cache" },
      fallback: { used: true },
      reason: { code: "cloud_fallback", message: "local engine unavailable, using cloud fallback" },
    };
    expect(cloudMeta.execution?.locality).toBe("cloud");
    expect(cloudMeta.execution?.mode).toBe("hosted_gateway");
    expect(cloudMeta.execution?.engine).toBeNull();
    expect(cloudMeta.artifact).toBeNull();
    expect(cloudMeta.model.resolved).toBeNull();
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

// ---------------------------------------------------------------------------
// RouteMetadata — contract locality enforcement
// ---------------------------------------------------------------------------

describe("RouteMetadata locality enforcement", () => {
  it("accepts 'local' as a valid locality", () => {
    const execution: RouteExecution = { locality: "local", mode: "sdk_runtime", engine: "llama.cpp" };
    expect(execution.locality).toBe("local");
  });

  it("accepts 'cloud' as a valid locality", () => {
    const execution: RouteExecution = { locality: "cloud", mode: "hosted_gateway", engine: null };
    expect(execution.locality).toBe("cloud");
  });

  it("'on_device' is NOT a valid locality value", () => {
    // The contract specifies "local" | "cloud" only.
    // Telemetry adapters may map "local" -> "on_device" internally,
    // but the public RouteMetadata type must not accept "on_device".
    const validLocalities = ["local", "cloud"] as const;
    expect(validLocalities).not.toContain("on_device");

    // Runtime check: if wire data contained "on_device", it should be rejected
    const wireData = "on_device";
    const isValid = wireData === "local" || wireData === "cloud";
    expect(isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RouteMetadata — execution.mode values
// ---------------------------------------------------------------------------

describe("RouteExecution.mode values", () => {
  it("sdk_runtime is used for local inference", () => {
    const execution: RouteExecution = { locality: "local", mode: "sdk_runtime", engine: "llama.cpp" };
    expect(execution.mode).toBe("sdk_runtime");
  });

  it("hosted_gateway is used for api.octomil.com cloud inference", () => {
    const execution: RouteExecution = { locality: "cloud", mode: "hosted_gateway", engine: null };
    expect(execution.mode).toBe("hosted_gateway");
  });

  it("external_endpoint is used for user-configured endpoints", () => {
    const execution: RouteExecution = { locality: "cloud", mode: "external_endpoint", engine: null };
    expect(execution.mode).toBe("external_endpoint");
  });

  it("all three modes are distinct", () => {
    const modes = ["sdk_runtime", "hosted_gateway", "external_endpoint"] as const;
    const unique = new Set(modes);
    expect(unique.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// RouteMetadata — contract fixture validation
// ---------------------------------------------------------------------------

describe("RouteMetadata contract fixture", () => {
  it("constructs a full route metadata object matching the contract JSON wire format", () => {
    // This fixture mirrors the canonical contract shape from octomil-contracts
    const fixture: RouteMetadata = {
      status: "selected",
      execution: {
        locality: "local",
        mode: "sdk_runtime",
        engine: "llama.cpp",
      },
      model: {
        requested: {
          ref: "phi-4-mini",
          kind: "model",
          capability: "chat",
        },
        resolved: {
          id: "model-uuid-123",
          slug: "phi-4-mini",
          version_id: "v1.0.0",
          variant_id: "gguf-q4",
        },
      },
      artifact: {
        id: "artifact-uuid-456",
        version: "v1.0.0",
        format: "gguf",
        digest: "sha256:deadbeef",
        cache: {
          status: "hit",
          managed_by: "octomil",
        },
      },
      planner: {
        source: "server",
      },
      fallback: {
        used: false,
      },
      reason: {
        code: "engine_available",
        message: "Local engine llama.cpp available and preferred by policy",
      },
    };

    // Validate every nested field
    expect(fixture.status).toBe("selected");

    // execution
    expect(fixture.execution).not.toBeNull();
    expect(fixture.execution!.locality).toBe("local");
    expect(fixture.execution!.mode).toBe("sdk_runtime");
    expect(fixture.execution!.engine).toBe("llama.cpp");

    // model.requested
    expect(fixture.model.requested.ref).toBe("phi-4-mini");
    expect(fixture.model.requested.kind).toBe("model");
    expect(fixture.model.requested.capability).toBe("chat");

    // model.resolved
    expect(fixture.model.resolved).not.toBeNull();
    expect(fixture.model.resolved!.id).toBe("model-uuid-123");
    expect(fixture.model.resolved!.slug).toBe("phi-4-mini");
    expect(fixture.model.resolved!.version_id).toBe("v1.0.0");
    expect(fixture.model.resolved!.variant_id).toBe("gguf-q4");

    // artifact
    expect(fixture.artifact).not.toBeNull();
    expect(fixture.artifact!.id).toBe("artifact-uuid-456");
    expect(fixture.artifact!.version).toBe("v1.0.0");
    expect(fixture.artifact!.format).toBe("gguf");
    expect(fixture.artifact!.digest).toBe("sha256:deadbeef");
    expect(fixture.artifact!.cache.status).toBe("hit");
    expect(fixture.artifact!.cache.managed_by).toBe("octomil");

    // planner, fallback, reason
    expect(fixture.planner.source).toBe("server");
    expect(fixture.fallback.used).toBe(false);
    expect(fixture.reason.code).toBe("engine_available");
    expect(fixture.reason.message).toContain("llama.cpp");
  });

  it("constructs an unavailable route metadata with null execution and artifact", () => {
    const fixture: RouteMetadata = {
      status: "unavailable",
      execution: null,
      model: {
        requested: {
          ref: "unsupported-model",
          kind: "unknown",
          capability: null,
        },
        resolved: null,
      },
      artifact: null,
      planner: { source: "offline" },
      fallback: { used: false },
      reason: { code: "no_engine", message: "No compatible engine found" },
    };

    expect(fixture.status).toBe("unavailable");
    expect(fixture.execution).toBeNull();
    expect(fixture.model.requested.kind).toBe("unknown");
    expect(fixture.model.resolved).toBeNull();
    expect(fixture.artifact).toBeNull();
    expect(fixture.planner.source).toBe("offline");
    expect(fixture.reason.code).toBe("no_engine");
  });

  it("validates all ArtifactCache.status values", () => {
    const statuses: ArtifactCache["status"][] = ["hit", "miss", "downloaded", "not_applicable", "unavailable"];
    expect(statuses).toHaveLength(5);
    statuses.forEach((s) => expect(typeof s).toBe("string"));
  });

  it("validates all ArtifactCache.managed_by values", () => {
    const managers: NonNullable<ArtifactCache["managed_by"]>[] = ["octomil", "runtime", "external"];
    expect(managers).toHaveLength(3);
    // null is also valid
    const cache: ArtifactCache = { status: "not_applicable", managed_by: null };
    expect(cache.managed_by).toBeNull();
  });

  it("validates all RouteModelRequested.kind values", () => {
    const kinds: RouteModelRequested["kind"][] = ["model", "app", "deployment", "alias", "default", "unknown"];
    expect(kinds).toHaveLength(6);
  });
});
