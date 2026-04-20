import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  RuntimePlannerClient,
  parsePlanResponse,
} from "../src/planner/client.js";
import type {
  RuntimePlanRequest,
  RuntimeBenchmarkSubmission,
  RuntimePlanResponse,
  RuntimeDefaultsResponse,
  DeviceRuntimeProfile,
} from "../src/planner/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DEVICE: DeviceRuntimeProfile = {
  sdk: "node",
  sdk_version: "1.2.0",
  platform: "darwin",
  arch: "arm64",
  os_version: "24.0.0",
  ram_total_bytes: 34_359_738_368,
  accelerators: ["metal"],
  installed_runtimes: [
    { engine: "onnxruntime-node", available: true },
  ],
};

const TEST_PLAN_REQUEST: RuntimePlanRequest = {
  model: "phi-4-mini",
  capability: "chat",
  routing_policy: "local_first",
  device: TEST_DEVICE,
  allow_cloud_fallback: true,
};

const SERVER_PLAN_RESPONSE = {
  model: "phi-4-mini",
  capability: "chat",
  policy: "local_first",
  candidates: [
    {
      locality: "local",
      engine: "onnxruntime-node",
      priority: 1,
      confidence: 0.92,
      reason: "engine installed and model format supported",
      benchmark_required: false,
      artifact: {
        model_id: "phi-4-mini",
        artifact_id: "artifact-abc",
        format: "onnx",
        size_bytes: 2_000_000_000,
      },
    },
  ],
  fallback_candidates: [
    {
      locality: "cloud",
      priority: 2,
      confidence: 0.8,
      reason: "cloud fallback available",
    },
  ],
  plan_ttl_seconds: 604800,
  server_generated_at: "2026-04-20T12:00:00Z",
};

const SERVER_DEFAULTS_RESPONSE: RuntimeDefaultsResponse = {
  default_engines: {
    chat: ["llama.cpp", "onnxruntime-node"],
    embeddings: ["onnxruntime-node"],
    transcription: ["whisper.cpp"],
  },
  supported_capabilities: ["chat", "responses", "embeddings", "transcription", "audio"],
  supported_policies: [
    "private",
    "local_only",
    "local_first",
    "cloud_first",
    "cloud_only",
    "performance_first",
  ],
  plan_ttl_seconds: 604800,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RuntimePlannerClient", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("uses default base URL when none provided", () => {
      const client = new RuntimePlannerClient();
      // We verify indirectly by calling fetchPlan and checking the URL
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_PLAN_RESPONSE), { status: 200 }),
      );

      void client.fetchPlan(TEST_PLAN_REQUEST);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.octomil.com/api/v2/runtime/plan",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("strips trailing slashes from base URL", () => {
      const client = new RuntimePlannerClient({
        baseUrl: "https://custom.api.com///",
        apiKey: "test-key",
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_PLAN_RESPONSE), { status: 200 }),
      );

      void client.fetchPlan(TEST_PLAN_REQUEST);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://custom.api.com/api/v2/runtime/plan",
        expect.anything(),
      );
    });

    it("sets Authorization header when apiKey provided", () => {
      const client = new RuntimePlannerClient({ apiKey: "my-key" });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_PLAN_RESPONSE), { status: 200 }),
      );

      void client.fetchPlan(TEST_PLAN_REQUEST);

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer my-key",
          }),
        }),
      );
    });

    it("omits Authorization header when no apiKey", () => {
      const client = new RuntimePlannerClient();

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_PLAN_RESPONSE), { status: 200 }),
      );

      void client.fetchPlan(TEST_PLAN_REQUEST);

      const callHeaders = (fetchSpy.mock.calls[0]?.[1] as RequestInit)
        ?.headers as Record<string, string>;
      expect(callHeaders?.["Authorization"]).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // fetchPlan
  // -----------------------------------------------------------------------

  describe("fetchPlan", () => {
    it("sends correct request body to POST /api/v2/runtime/plan", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_PLAN_RESPONSE), { status: 200 }),
      );

      await client.fetchPlan(TEST_PLAN_REQUEST);

      const body = JSON.parse(
        fetchSpy.mock.calls[0]?.[1]?.body as string,
      ) as RuntimePlanRequest;
      expect(body.model).toBe("phi-4-mini");
      expect(body.capability).toBe("chat");
      expect(body.routing_policy).toBe("local_first");
      expect(body.device.sdk).toBe("node");
      expect(body.device.platform).toBe("darwin");
      expect(body.allow_cloud_fallback).toBe(true);
    });

    it("returns parsed RuntimePlanResponse on success", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_PLAN_RESPONSE), { status: 200 }),
      );

      const result = await client.fetchPlan(TEST_PLAN_REQUEST);

      expect(result).not.toBeNull();
      expect(result!.model).toBe("phi-4-mini");
      expect(result!.capability).toBe("chat");
      expect(result!.policy).toBe("local_first");
      expect(result!.candidates).toHaveLength(1);
      expect(result!.candidates[0]!.locality).toBe("local");
      expect(result!.candidates[0]!.engine).toBe("onnxruntime-node");
      expect(result!.candidates[0]!.artifact?.model_id).toBe("phi-4-mini");
      expect(result!.candidates[0]!.artifact?.format).toBe("onnx");
      expect(result!.fallback_candidates).toHaveLength(1);
      expect(result!.fallback_candidates[0]!.locality).toBe("cloud");
      expect(result!.plan_ttl_seconds).toBe(604800);
      expect(result!.server_generated_at).toBe("2026-04-20T12:00:00Z");
    });

    it("returns null on network failure", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));

      const result = await client.fetchPlan(TEST_PLAN_REQUEST);
      expect(result).toBeNull();
    });

    it("returns null on HTTP error (non-2xx)", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const result = await client.fetchPlan(TEST_PLAN_REQUEST);
      expect(result).toBeNull();
    });

    it("returns null on 401 Unauthorized", async () => {
      const client = new RuntimePlannerClient({ apiKey: "bad-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );

      const result = await client.fetchPlan(TEST_PLAN_REQUEST);
      expect(result).toBeNull();
    });

    it("returns null on malformed JSON response", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response("not json", { status: 200 }),
      );

      const result = await client.fetchPlan(TEST_PLAN_REQUEST);
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // submitBenchmark
  // -----------------------------------------------------------------------

  describe("submitBenchmark", () => {
    it("sends POST to /api/v2/runtime/benchmarks and returns true on success", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      const submission: RuntimeBenchmarkSubmission = {
        source: "planner",
        model: "phi-4-mini",
        capability: "chat",
        engine: "onnxruntime-node",
        device: TEST_DEVICE,
        success: true,
        tokens_per_second: 42.5,
        ttft_ms: 150,
      };

      const result = await client.submitBenchmark(submission);
      expect(result).toBe(true);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.octomil.com/api/v2/runtime/benchmarks",
        expect.objectContaining({
          method: "POST",
        }),
      );
    });

    it("returns false on network failure", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));

      const result = await client.submitBenchmark({
        source: "planner",
        model: "phi-4-mini",
        capability: "chat",
        engine: "onnxruntime-node",
        device: TEST_DEVICE,
        success: false,
      });
      expect(result).toBe(false);
    });

    it("returns false on HTTP error", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response("Server Error", { status: 500 }),
      );

      const result = await client.submitBenchmark({
        source: "planner",
        model: "phi-4-mini",
        capability: "chat",
        engine: "onnxruntime-node",
        device: TEST_DEVICE,
        success: true,
      });
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // fetchDefaults
  // -----------------------------------------------------------------------

  describe("fetchDefaults", () => {
    it("sends GET to /api/v2/runtime/defaults and returns parsed response", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(SERVER_DEFAULTS_RESPONSE), { status: 200 }),
      );

      const result = await client.fetchDefaults();

      expect(result).not.toBeNull();
      expect(result!.default_engines).toHaveProperty("chat");
      expect(result!.default_engines.chat).toContain("llama.cpp");
      expect(result!.supported_policies).toContain("private");
      expect(result!.supported_policies).toContain("performance_first");
      expect(result!.supported_capabilities).toContain("chat");
      expect(result!.plan_ttl_seconds).toBe(604800);

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.octomil.com/api/v2/runtime/defaults",
        expect.objectContaining({
          method: "GET",
        }),
      );
    });

    it("returns null on network failure", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));

      const result = await client.fetchDefaults();
      expect(result).toBeNull();
    });

    it("returns null on HTTP error", async () => {
      const client = new RuntimePlannerClient({ apiKey: "test-key" });
      fetchSpy.mockResolvedValueOnce(
        new Response("Not Found", { status: 404 }),
      );

      const result = await client.fetchDefaults();
      expect(result).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// parsePlanResponse (standalone parsing tests)
// ---------------------------------------------------------------------------

describe("parsePlanResponse", () => {
  it("parses a full server response correctly", () => {
    const result = parsePlanResponse(SERVER_PLAN_RESPONSE);

    expect(result.model).toBe("phi-4-mini");
    expect(result.capability).toBe("chat");
    expect(result.policy).toBe("local_first");
    expect(result.candidates).toHaveLength(1);
    expect(result.fallback_candidates).toHaveLength(1);
    expect(result.plan_ttl_seconds).toBe(604800);
    expect(result.server_generated_at).toBe("2026-04-20T12:00:00Z");
  });

  it("parses candidate artifact fields", () => {
    const result = parsePlanResponse(SERVER_PLAN_RESPONSE);
    const candidate = result.candidates[0]!;

    expect(candidate.locality).toBe("local");
    expect(candidate.engine).toBe("onnxruntime-node");
    expect(candidate.priority).toBe(1);
    expect(candidate.confidence).toBe(0.92);
    expect(candidate.benchmark_required).toBe(false);
    expect(candidate.artifact).toBeDefined();
    expect(candidate.artifact!.model_id).toBe("phi-4-mini");
    expect(candidate.artifact!.artifact_id).toBe("artifact-abc");
    expect(candidate.artifact!.format).toBe("onnx");
    expect(candidate.artifact!.size_bytes).toBe(2_000_000_000);
  });

  it("handles missing optional fields with defaults", () => {
    const minimal = {
      model: "tiny-model",
    };
    const result = parsePlanResponse(minimal as Record<string, unknown>);

    expect(result.model).toBe("tiny-model");
    expect(result.capability).toBe("");
    expect(result.policy).toBe("");
    expect(result.candidates).toEqual([]);
    expect(result.fallback_candidates).toEqual([]);
    expect(result.plan_ttl_seconds).toBe(604800);
    expect(result.server_generated_at).toBe("");
  });

  it("handles candidates without artifacts", () => {
    const data = {
      model: "phi-4-mini",
      capability: "chat",
      policy: "cloud_only",
      candidates: [
        {
          locality: "cloud",
          priority: 1,
          confidence: 1.0,
          reason: "cloud only",
        },
      ],
      fallback_candidates: [],
      plan_ttl_seconds: 3600,
      server_generated_at: "2026-04-20T00:00:00Z",
    };

    const result = parsePlanResponse(data);
    expect(result.candidates[0]!.artifact).toBeUndefined();
    expect(result.candidates[0]!.engine).toBeUndefined();
    expect(result.candidates[0]!.engine_version_constraint).toBeUndefined();
  });

  it("defaults plan_ttl_seconds to 604800 when missing", () => {
    const data = {
      model: "test",
      candidates: [],
    };
    const result = parsePlanResponse(data as Record<string, unknown>);
    expect(result.plan_ttl_seconds).toBe(604800);
  });

  it("defaults locality to 'local' when unrecognized", () => {
    const data = {
      model: "test",
      candidates: [
        { locality: "edge", priority: 1, confidence: 0.5, reason: "test" },
      ],
    };
    const result = parsePlanResponse(data as Record<string, unknown>);
    expect(result.candidates[0]!.locality).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Policy-specific plan response validation
// ---------------------------------------------------------------------------

describe("policy-specific plan validation", () => {
  it("private policy plan has zero cloud candidates", () => {
    const privatePlan = parsePlanResponse({
      model: "phi-4-mini",
      capability: "chat",
      policy: "private",
      candidates: [
        {
          locality: "local",
          engine: "llama.cpp",
          priority: 1,
          confidence: 0.95,
          reason: "private — local only",
        },
      ],
      fallback_candidates: [],
    });

    const allCandidates = [
      ...privatePlan.candidates,
      ...privatePlan.fallback_candidates,
    ];
    const cloudCount = allCandidates.filter(
      (c) => c.locality === "cloud",
    ).length;
    expect(cloudCount).toBe(0);
  });

  it("cloud_only policy plan has zero local candidates", () => {
    const cloudPlan = parsePlanResponse({
      model: "gpt-4o",
      capability: "chat",
      policy: "cloud_only",
      candidates: [
        {
          locality: "cloud",
          priority: 1,
          confidence: 1.0,
          reason: "cloud only",
        },
      ],
      fallback_candidates: [],
    });

    const allCandidates = [
      ...cloudPlan.candidates,
      ...cloudPlan.fallback_candidates,
    ];
    const localCount = allCandidates.filter(
      (c) => c.locality === "local",
    ).length;
    expect(localCount).toBe(0);
  });
});
