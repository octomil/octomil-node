/**
 * Runtime boundary tests — verify clean separation between layers.
 *
 * The Node SDK has three layers:
 *   1. Product clients  (src/responses.ts, src/chat.ts, src/embeddings.ts, src/audio/)
 *   2. Runtime routing  (src/runtime/routing/)
 *   3. Planner          (src/planner/)
 *
 * Boundary rules:
 * - Product clients import from runtime/routing, never directly from planner/
 * - runtime/routing contains: attempt-runner, request-router, route-event, model-ref-parser, planner-client
 * - planner/ contains: client (HTTP), types (server API shapes), device-profile, cache
 * - RouteMetadata exists in BOTH planner/types.ts (canonical wire format) and
 *   runtime/routing/request-router.ts (internal routing shape) — intentional divergence
 * - FORBIDDEN_TELEMETRY_KEYS is enforced by route-event.ts before any event is emitted
 * - No product client duplicates routing logic — all route through shared infrastructure
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Import the modules under test
// ---------------------------------------------------------------------------

import {
  CandidateAttemptRunner,
  NoOpRuntimeChecker,
  NoOpGateEvaluator,
  AttemptStage,
  AttemptStatus,
  GateStatus,
  GATE_CODES,
  type CandidatePlan,
  type RuntimeChecker,
  type GateEvaluator,
  type RouteAttempt,
} from "../src/runtime/routing/attempt-runner.js";

import {
  RequestRouter,
  type RouterConfig,
  type RequestRoutingContext,
  type PlannerResult,
  type RouteMetadata as RoutingRouteMetadata,
} from "../src/runtime/routing/request-router.js";

import {
  buildRouteEvent,
  validateRouteEvent,
  stripForbiddenKeys,
  FORBIDDEN_TELEMETRY_KEYS,
  type RouteEvent,
} from "../src/runtime/routing/route-event.js";

import { parseModelRef } from "../src/runtime/routing/model-ref-parser.js";

import type { RouteMetadata as PlannerRouteMetadata } from "../src/planner/types.js";

// ---------------------------------------------------------------------------
// Source file layout validation
// ---------------------------------------------------------------------------

describe("Runtime boundary — module layout", () => {
  const PLANNER_DIR = join(__dirname, "..", "src", "planner");
  const ROUTING_DIR = join(__dirname, "..", "src", "runtime", "routing");

  it("planner/ contains only HTTP client, types, device-profile, and index", () => {
    const files = readdirSync(PLANNER_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files).toEqual(
      expect.arrayContaining(["client.ts", "device-profile.ts", "index.ts", "types.ts"]),
    );
    // No routing logic files should be in planner/
    for (const f of files) {
      expect(f).not.toContain("attempt");
      expect(f).not.toContain("route-event");
      expect(f).not.toContain("request-router");
    }
  });

  it("runtime/routing/ contains attempt-runner, request-router, route-event, model-ref-parser, planner-client, and index", () => {
    const files = readdirSync(ROUTING_DIR)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(files).toEqual(
      expect.arrayContaining([
        "attempt-runner.ts",
        "index.ts",
        "model-ref-parser.ts",
        "planner-client.ts",
        "request-router.ts",
        "route-event.ts",
      ]),
    );
  });

  it("product clients do NOT import from src/planner/ directly", () => {
    const productFiles = [
      join(__dirname, "..", "src", "responses.ts"),
      join(__dirname, "..", "src", "chat.ts"),
      join(__dirname, "..", "src", "embeddings.ts"),
      join(__dirname, "..", "src", "audio", "audio-transcriptions.ts"),
    ];

    for (const file of productFiles) {
      let content: string;
      try {
        content = readFileSync(file, "utf-8");
      } catch {
        // File might not exist in some configurations
        continue;
      }
      const lines = content.split("\n");
      for (const line of lines) {
        if (line.trim().startsWith("import") && line.includes("planner/")) {
          // Importing from runtime/routing/planner-client is fine
          expect(line).toMatch(/runtime\/routing\/planner-client/);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CandidateAttemptRunner boundary
// ---------------------------------------------------------------------------

describe("Runtime boundary — CandidateAttemptRunner", () => {
  it("NoOpRuntimeChecker allows cloud, rejects local", () => {
    const checker = new NoOpRuntimeChecker();
    expect(checker.check(null, "cloud").available).toBe(true);
    expect(checker.check("llama.cpp", "local").available).toBe(false);
    expect(checker.check("llama.cpp", "local").reasonCode).toBe(
      "no_local_runtime_checker",
    );
  });

  it("NoOpGateEvaluator returns not_required for optional, unknown for required", () => {
    const evaluator = new NoOpGateEvaluator();
    const optional = evaluator.evaluate(
      { code: "min_tokens_per_second", required: false, source: "server" },
      null,
      "cloud",
    );
    expect(optional.status).toBe(GateStatus.NotRequired);

    const required = evaluator.evaluate(
      { code: "context_fits", required: true, source: "server" },
      null,
      "cloud",
    );
    expect(required.status).toBe(GateStatus.Unknown);
  });

  it("cloud candidate is selected directly with all gates passed", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false });
    const result = runner.run([
      {
        locality: "cloud",
        engine: "cloud",
        priority: 0,
        confidence: 1,
        reason: "test",
      },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.status).toBe(AttemptStatus.Selected);
    expect(result.selectedAttempt!.stage).toBe(AttemptStage.Inference);
    expect(result.attempts).toHaveLength(1);
    expect(result.fallbackUsed).toBe(false);
  });

  it("local candidate fails with default checker, falls back to cloud", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true });
    const result = runner.run([
      { locality: "local", engine: "mlx-lm", priority: 0, confidence: 1, reason: "test" },
      { locality: "cloud", engine: "cloud", priority: 1, confidence: 1, reason: "fallback" },
    ]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger!.code).toBe("runtime_unavailable");
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
  });

  it("fallback disabled: stops at first failure", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false });
    const result = runner.run([
      { locality: "local", engine: "mlx-lm", priority: 0, confidence: 1, reason: "test" },
      { locality: "cloud", engine: "cloud", priority: 1, confidence: 1, reason: "fallback" },
    ]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe(AttemptStatus.Failed);
    expect(result.fallbackUsed).toBe(false);
  });

  it("GATE_CODES contains all 12 canonical gate codes", () => {
    expect(GATE_CODES).toHaveLength(12);
    expect(GATE_CODES).toContain("artifact_verified");
    expect(GATE_CODES).toContain("runtime_available");
    expect(GATE_CODES).toContain("benchmark_fresh");
  });

  it("AttemptStage, AttemptStatus, GateStatus enums match contract values", () => {
    expect(AttemptStage.Policy).toBe("policy");
    expect(AttemptStage.Prepare).toBe("prepare");
    expect(AttemptStage.Inference).toBe("inference");
    expect(AttemptStatus.Selected).toBe("selected");
    expect(AttemptStatus.Failed).toBe("failed");
    expect(GateStatus.Passed).toBe("passed");
    expect(GateStatus.Failed).toBe("failed");
    expect(GateStatus.Unknown).toBe("unknown");
    expect(GateStatus.NotRequired).toBe("not_required");
  });
});

// ---------------------------------------------------------------------------
// RequestRouter boundary
// ---------------------------------------------------------------------------

describe("Runtime boundary — RequestRouter", () => {
  const baseConfig: RouterConfig = {
    cloudEndpoint: "https://api.example.com",
  };

  it("routes to hosted_gateway without planner result (legacy path)", () => {
    const router = new RequestRouter(baseConfig);
    const decision = router.resolve({
      model: "test-model",
      capability: "chat",
      streaming: false,
    });

    expect(decision.locality).toBe("cloud");
    expect(decision.mode).toBe("hosted_gateway");
    expect(decision.endpoint).toBe("https://api.example.com");
    expect(decision.routeMetadata.plannerUsed).toBe(false);
  });

  it("routes to hosted_gateway with cloud-only planner result", () => {
    const router = new RequestRouter(baseConfig);
    const plan: PlannerResult = {
      model: "test-model",
      capability: "chat",
      policy: "cloud_only",
      candidates: [
        { locality: "cloud", engine: "cloud", priority: 0, confidence: 1, reason: "cloud-only" },
      ],
      fallback_allowed: false,
    };

    const decision = router.resolve({
      model: "test-model",
      capability: "chat",
      streaming: false,
      plannerResult: plan,
    });

    expect(decision.locality).toBe("cloud");
    expect(decision.mode).toBe("hosted_gateway");
    expect(decision.routeMetadata.plannerUsed).toBe(true);
    expect(decision.attemptResult.selectedAttempt).not.toBeNull();
  });

  it("routes local candidate to external_endpoint when externalEndpoint is configured", () => {
    const router = new RequestRouter({
      ...baseConfig,
      externalEndpoint: "http://localhost:8080",
    });

    const plan: PlannerResult = {
      model: "phi-4-mini",
      capability: "chat",
      policy: "local_first",
      candidates: [
        { locality: "local", engine: "mlx-lm", priority: 0, confidence: 1, reason: "local-first" },
        { locality: "cloud", engine: "cloud", priority: 1, confidence: 1, reason: "fallback" },
      ],
      fallback_allowed: true,
    };

    const decision = router.resolve({
      model: "phi-4-mini",
      capability: "chat",
      streaming: false,
      plannerResult: plan,
    });

    expect(decision.locality).toBe("local");
    expect(decision.mode).toBe("external_endpoint");
    expect(decision.endpoint).toBe("http://localhost:8080");
  });

  it("builds route event with no forbidden keys", () => {
    const router = new RequestRouter(baseConfig);
    const decision = router.resolve({
      model: "test-model",
      capability: "chat",
      streaming: false,
    });

    expect(decision.routeMetadata.routeEvent).toBeDefined();
    // validateRouteEvent would have thrown if forbidden keys existed
    expect(() => validateRouteEvent(decision.routeMetadata.routeEvent!)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// RouteEvent + forbidden telemetry keys
// ---------------------------------------------------------------------------

describe("Runtime boundary — FORBIDDEN_TELEMETRY_KEYS enforcement", () => {
  it("FORBIDDEN_TELEMETRY_KEYS contains all required keys", () => {
    const required = [
      "prompt", "input", "output", "completion", "audio", "audio_bytes",
      "file_path", "text", "content", "messages", "system_prompt", "documents",
    ];
    for (const key of required) {
      expect(FORBIDDEN_TELEMETRY_KEYS.has(key)).toBe(true);
    }
  });

  it("validateRouteEvent throws if a forbidden key is present", () => {
    const event = buildRouteEvent({
      requestId: "req_test",
      capability: "chat",
      streaming: false,
      model: "test",
      attemptResult: {
        selectedAttempt: null,
        attempts: [],
        fallbackUsed: false,
        fallbackTrigger: null,
        fromAttempt: null,
        toAttempt: null,
      },
    });

    // Manually inject a forbidden key to test validation
    const tampered = { ...event, prompt: "SHOULD NOT BE HERE" } as unknown as RouteEvent;
    expect(() => validateRouteEvent(tampered)).toThrow("forbidden telemetry field");
  });

  it("stripForbiddenKeys removes forbidden keys recursively", () => {
    const obj = {
      route_id: "rt_abc",
      prompt: "SECRET",
      input: "SECRET",
      output: "SECRET",
      nested: {
        content: "SECRET",
        safe_field: "ok",
      },
    };

    const stripped = stripForbiddenKeys(obj);
    expect(stripped).not.toHaveProperty("prompt");
    expect(stripped).not.toHaveProperty("input");
    expect(stripped).not.toHaveProperty("output");
    expect((stripped as Record<string, unknown>).route_id).toBe("rt_abc");
    expect(
      ((stripped as Record<string, unknown>).nested as Record<string, unknown>).safe_field,
    ).toBe("ok");
    expect(
      (stripped as Record<string, unknown>).nested,
    ).not.toHaveProperty("content");
  });

  it("buildRouteEvent produces a valid RouteEvent with required fields", () => {
    const event = buildRouteEvent({
      requestId: "req_test",
      capability: "chat",
      streaming: false,
      model: "phi-4-mini",
      modelRefKind: "model",
      plannerSource: "server",
      attemptResult: {
        selectedAttempt: {
          index: 0,
          locality: "cloud",
          mode: "hosted_gateway",
          engine: null,
          artifact: null,
          status: AttemptStatus.Selected,
          stage: AttemptStage.Inference,
          gate_results: [{ code: "runtime_available", status: GateStatus.Passed }],
          reason: { code: "selected", message: "all gates passed" },
        },
        attempts: [{
          index: 0,
          locality: "cloud",
          mode: "hosted_gateway",
          engine: null,
          artifact: null,
          status: AttemptStatus.Selected,
          stage: AttemptStage.Inference,
          gate_results: [{ code: "runtime_available", status: GateStatus.Passed }],
          reason: { code: "selected", message: "all gates passed" },
        }],
        fallbackUsed: false,
        fallbackTrigger: null,
        fromAttempt: null,
        toAttempt: null,
      },
    });

    expect(event.route_id).toBeTruthy();
    expect(event.request_id).toBe("req_test");
    expect(event.capability).toBe("chat");
    expect(event.final_locality).toBe("cloud");
    expect(event.selected_locality).toBe("cloud");
    expect(event.final_mode).toBe("hosted_gateway");
    expect(event.fallback_used).toBe(false);
    expect(event.candidate_attempts).toBe(1);
    expect(event.attempt_details).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Model ref parser boundary
// ---------------------------------------------------------------------------

describe("Runtime boundary — model ref parser", () => {
  it("parses plain model ID", () => {
    const ref = parseModelRef("phi-4-mini");
    expect(ref.kind).toBe("model");
    expect(ref.raw).toBe("phi-4-mini");
  });

  it("parses @app/slug/capability ref", () => {
    const ref = parseModelRef("@app/my-app/chat");
    expect(ref.kind).toBe("app");
    expect(ref.appSlug).toBe("my-app");
    expect(ref.capability).toBe("chat");
  });

  it("parses deploy_ ref", () => {
    const ref = parseModelRef("deploy_abc123");
    expect(ref.kind).toBe("deployment");
    expect(ref.deploymentId).toBe("deploy_abc123");
  });
});

// ---------------------------------------------------------------------------
// Planner vs routing RouteMetadata type divergence (compile-time check)
// ---------------------------------------------------------------------------

describe("Runtime boundary — RouteMetadata type divergence", () => {
  it("planner RouteMetadata has canonical wire-format fields", () => {
    // This test verifies at compile time that the planner RouteMetadata
    // has the expected shape. If the type changes, this will fail to compile.
    const metadata: PlannerRouteMetadata = {
      status: "selected",
      execution: { locality: "cloud", mode: "hosted_gateway", engine: null },
      model: {
        requested: { ref: "phi-4-mini", kind: "model", capability: "chat" },
        resolved: null,
      },
      artifact: null,
      planner: { source: "server" },
      fallback: { used: false },
      reason: { code: "selected", message: "all gates passed" },
    };

    expect(metadata.status).toBe("selected");
    expect(metadata.execution!.locality).toBe("cloud");
    expect(metadata.planner.source).toBe("server");
  });

  it("routing RouteMetadata has internal routing decision fields", () => {
    const metadata: RoutingRouteMetadata = {
      modelRefKind: "model",
      parsedRef: { kind: "model", model: "phi-4-mini" },
      locality: "cloud",
      mode: "hosted_gateway",
      endpoint: "https://api.example.com",
      plannerUsed: false,
    };

    expect(metadata.modelRefKind).toBe("model");
    expect(metadata.plannerUsed).toBe(false);
    expect(metadata.endpoint).toBe("https://api.example.com");
  });
});

// ---------------------------------------------------------------------------
// Streaming fallback semantics
// ---------------------------------------------------------------------------

describe("Runtime boundary — streaming fallback semantics", () => {
  it("non-streaming: fallback always allowed", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true, streaming: false });
    expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
    expect(runner.shouldFallbackAfterInferenceError(true)).toBe(true);
  });

  it("streaming pre-first-token: fallback allowed", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true, streaming: true });
    expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
  });

  it("streaming post-first-token: fallback NOT allowed", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true, streaming: true });
    expect(runner.shouldFallbackAfterInferenceError(true)).toBe(false);
  });

  it("fallback disabled: never fallback regardless of streaming state", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false, streaming: true });
    expect(runner.shouldFallbackAfterInferenceError(false)).toBe(false);
  });
});
