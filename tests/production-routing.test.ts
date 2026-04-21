/**
 * Tests for production planner-routed request paths.
 *
 * Verifies that:
 * 1. Production paths use planner candidates, not legacy direct routes
 * 2. Streaming no-fallback-after-first-token
 * 3. Deployment/experiment refs resolve and route correctly
 * 4. Telemetry payload excludes banned fields
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ResponsesClient,
  RequestRouter,
  PlannerClient,
  parseModelRef,
  buildRouteEvent,
  validateRouteEvent,
  FORBIDDEN_TELEMETRY_FIELDS,
  CandidateAttemptRunner,
  AttemptStage,
  AttemptStatus,
} from "../src/index.js";
import type {
  PlannerResult,
  CandidatePlan,
  RouteEvent,
  AttemptLoopResult,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeSseResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function cloudChatCompletion(id = "resp_test", content = "Hello") {
  return {
    id,
    model: "phi-4-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
  };
}

function cloudPlannerResponse(overrides: Partial<PlannerResult> = {}): PlannerResult {
  return {
    model: "phi-4-mini",
    capability: "responses",
    policy: "cloud_first",
    candidates: [
      {
        locality: "cloud",
        engine: "cloud",
        priority: 0,
        confidence: 1,
        reason: "cloud candidate from planner",
        gates: [],
      },
    ],
    fallback_allowed: true,
    plan_id: "plan_test_001",
    planner_source: "server",
    ...overrides,
  };
}

function localFirstPlannerResponse(): PlannerResult {
  return {
    model: "gemma3-1b",
    capability: "responses",
    policy: "local_first",
    candidates: [
      {
        locality: "local",
        engine: "llama.cpp",
        artifact: { artifact_id: "art_001", digest: "sha256:abc" },
        priority: 0,
        confidence: 0.8,
        reason: "local first candidate",
        gates: [
          { code: "runtime_available", required: true, source: "server" as const },
          { code: "model_loads", required: true, source: "server" as const },
        ],
      },
      {
        locality: "cloud",
        engine: "cloud",
        priority: 1,
        confidence: 0.99,
        reason: "cloud fallback",
        gates: [],
      },
    ],
    fallback_allowed: true,
    plan_id: "plan_local_first_001",
    planner_source: "server",
  };
}

// ---------------------------------------------------------------------------
// 1. Production path uses planner candidates, not legacy direct route
// ---------------------------------------------------------------------------

describe("Production path: planner candidates", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("responses.create fetches a plan and routes through candidates", async () => {
    const plannerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/v1/runtime/plan")) {
          return makeJsonResponse(cloudPlannerResponse());
        }
        if (urlStr.includes("/v1/chat/completions")) {
          return makeJsonResponse(cloudChatCompletion());
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test_key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test_key",
      }),
    });

    const response = await client.create({
      model: "phi-4-mini",
      input: "Hello",
    });

    expect(response.id).toBe("resp_test");
    expect(response.output).toHaveLength(1);

    // Verify planner was called
    const planCall = plannerFetch.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/v1/runtime/plan"),
    );
    expect(planCall).toBeDefined();

    // Verify inference was called
    const inferenceCall = plannerFetch.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].includes("/v1/chat/completions"),
    );
    expect(inferenceCall).toBeDefined();
  });

  it("responses.create with planner attaches route info", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/v1/runtime/plan")) {
        return makeJsonResponse(cloudPlannerResponse());
      }
      if (urlStr.includes("/v1/chat/completions")) {
        return makeJsonResponse(cloudChatCompletion());
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test_key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test_key",
      }),
    });

    await client.create({ model: "phi-4-mini", input: "Hello" });

    // The client should have route info from the last request
    expect(client.lastRouteInfo).not.toBeNull();
    expect(client.lastRouteInfo!.routeMetadata).toBeDefined();
    expect(client.lastRouteInfo!.routeMetadata.plannerUsed).toBe(true);
  });

  it("falls back to legacy route when planner is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/v1/runtime/plan")) {
        // Planner returns 503
        return new Response("Service Unavailable", { status: 503 });
      }
      if (urlStr.includes("/v1/chat/completions")) {
        return makeJsonResponse(cloudChatCompletion("resp_legacy"));
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test_key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test_key",
      }),
    });

    const response = await client.create({
      model: "phi-4-mini",
      input: "Hello",
    });

    // Should still succeed via legacy cloud path
    expect(response.id).toBe("resp_legacy");
  });

  it("without planner, uses legacy direct cloud route", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeJsonResponse(cloudChatCompletion("resp_direct")),
    );

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test_key",
      // No plannerClient
    });

    const response = await client.create({
      model: "phi-4-mini",
      input: "Hello",
    });

    expect(response.id).toBe("resp_direct");

    // Should NOT have called the planner endpoint
    const planCall = fetchSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("/api/v1/runtime/plan"),
    );
    expect(planCall).toBeUndefined();
  });

  it("responses.stream fetches a plan and routes through candidates", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/api/v1/runtime/plan")) {
        return makeJsonResponse(cloudPlannerResponse());
      }
      if (urlStr.includes("/v1/chat/completions")) {
        return makeSseResponse([
          'data: {"id":"resp_stream","model":"phi-4-mini","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n',
          'data: {"id":"resp_stream","model":"phi-4-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        ]);
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test_key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test_key",
      }),
    });

    const events = [];
    for await (const event of client.stream({
      model: "phi-4-mini",
      input: "Hello",
    })) {
      events.push(event);
    }

    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    expect(client.lastRouteInfo).not.toBeNull();
    expect(client.lastRouteInfo!.routeMetadata.plannerUsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Streaming no-fallback-after-first-token
// ---------------------------------------------------------------------------

describe("Streaming: no fallback after first token", () => {
  it("CandidateAttemptRunner blocks fallback after first output emitted", async () => {
    let emitted = false;
    const runner = new CandidateAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "llama.cpp",
        priority: 0,
        confidence: 0.9,
        reason: "local first",
      },
      {
        locality: "cloud",
        engine: "cloud",
        priority: 1,
        confidence: 1,
        reason: "cloud fallback",
      },
    ];

    const result = await runner.runWithInference(candidates, {
      runtimeChecker: {
        check: () => ({ available: true }),
      },
      executeCandidate: async (candidate) => {
        if (candidate.locality === "local") {
          emitted = true; // Simulate first token emitted
          throw new Error("stream interrupted after first token");
        }
        return "cloud-ok";
      },
      firstOutputEmitted: () => emitted,
    });

    // Should NOT fall back because first output was emitted
    expect(result.selectedAttempt).toBeNull();
    expect(result.value).toBeUndefined();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.reason.code).toBe(
      "inference_error_after_first_output",
    );
  });

  it("allows fallback before first token in streaming mode", async () => {
    const runner = new CandidateAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
    });

    const candidates: CandidatePlan[] = [
      {
        locality: "local",
        engine: "llama.cpp",
        priority: 0,
        confidence: 0.9,
        reason: "local first",
      },
      {
        locality: "cloud",
        engine: "cloud",
        priority: 1,
        confidence: 1,
        reason: "cloud fallback",
      },
    ];

    const result = await runner.runWithInference(candidates, {
      runtimeChecker: {
        check: () => ({ available: true }),
      },
      executeCandidate: async (candidate) => {
        if (candidate.locality === "local") {
          throw new Error("connection failed before any output");
        }
        return "cloud-ok";
      },
      firstOutputEmitted: () => false,
    });

    // Should fall back because no output was emitted yet
    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.value).toBe("cloud-ok");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger!.code).toBe(
      "inference_error_before_first_output",
    );
  });

  it("shouldFallbackAfterInferenceError returns false after first output", () => {
    const runner = new CandidateAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
    });

    expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
    expect(runner.shouldFallbackAfterInferenceError(true)).toBe(false);
  });

  it("shouldFallbackAfterInferenceError returns false when fallback disabled", () => {
    const runner = new CandidateAttemptRunner({
      fallbackAllowed: false,
      streaming: true,
    });

    expect(runner.shouldFallbackAfterInferenceError(false)).toBe(false);
    expect(runner.shouldFallbackAfterInferenceError(true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Deployment/experiment refs resolve and route correctly
// ---------------------------------------------------------------------------

describe("Deployment/experiment refs resolve and route", () => {
  it("parses deploy_xxx as deployment ref", () => {
    const parsed = parseModelRef("deploy_abc123");
    expect(parsed.kind).toBe("deployment");
    expect(parsed.deploymentId).toBe("abc123");
    expect(parsed.raw).toBe("deploy_abc123");
  });

  it("parses exp/xxx/variant as experiment ref", () => {
    const parsed = parseModelRef("exp/exp_001/variant_a");
    expect(parsed.kind).toBe("experiment");
    expect(parsed.experimentId).toBe("exp_001");
    expect(parsed.variantId).toBe("variant_a");
  });

  it("parses @app/slug/cap as app ref", () => {
    const parsed = parseModelRef("@app/translator/chat");
    expect(parsed.kind).toBe("app");
    expect(parsed.appSlug).toBe("translator");
    expect(parsed.capability).toBe("chat");
  });

  it("parses @capability/cap as capability ref", () => {
    const parsed = parseModelRef("@capability/transcription");
    expect(parsed.kind).toBe("capability");
    expect(parsed.capability).toBe("transcription");
  });

  it("parses bare model ID", () => {
    const parsed = parseModelRef("phi-4-mini");
    expect(parsed.kind).toBe("model");
    expect(parsed.raw).toBe("phi-4-mini");
  });

  it("deployment ref routes through RequestRouter with planner", () => {
    const plan: PlannerResult = {
      model: "phi-4-mini",
      capability: "responses",
      policy: "cloud_first",
      candidates: [
        {
          locality: "cloud",
          engine: "cloud",
          priority: 0,
          confidence: 1,
          reason: "deployment resolved to cloud",
        },
      ],
      fallback_allowed: true,
      plan_id: "plan_deploy_001",
      planner_source: "server",
    };

    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const decision = router.resolve({
      model: "deploy_my_deployment",
      capability: "responses",
      streaming: false,
      plannerResult: plan,
    });

    expect(decision.routeMetadata.modelRefKind).toBe("deployment");
    expect(decision.routeMetadata.parsedRef.deploymentId).toBe("my_deployment");
    expect(decision.routeMetadata.plannerUsed).toBe(true);
    expect(decision.locality).toBe("cloud");
  });

  it("experiment ref routes through RequestRouter with planner", () => {
    const plan: PlannerResult = {
      model: "phi-4-mini",
      capability: "chat",
      policy: "cloud_first",
      candidates: [
        {
          locality: "cloud",
          engine: "cloud",
          priority: 0,
          confidence: 1,
          reason: "experiment variant resolved",
        },
      ],
      fallback_allowed: true,
      plan_id: "plan_exp_001",
      planner_source: "server",
    };

    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const decision = router.resolve({
      model: "exp_test_001/variant_a",
      capability: "chat",
      streaming: false,
      plannerResult: plan,
    });

    expect(decision.routeMetadata.modelRefKind).toBe("experiment");
    // exp_test_001/variant_a is parsed by the exp regex: exp_ prefix is consumed,
    // yielding experimentId="test_001" and variantId="variant_a"
    expect(decision.routeMetadata.parsedRef.experimentId).toBe("test_001");
    expect(decision.routeMetadata.parsedRef.variantId).toBe("variant_a");
    expect(decision.routeMetadata.plannerUsed).toBe(true);
  });

  it("app ref includes app_slug in route event", () => {
    const plan: PlannerResult = {
      model: "gemma3-1b",
      capability: "chat",
      policy: "local_first",
      candidates: [
        {
          locality: "cloud",
          engine: "cloud",
          priority: 0,
          confidence: 1,
          reason: "cloud",
        },
      ],
      fallback_allowed: true,
      plan_id: "plan_app_001",
      planner_source: "server",
      app_resolution: {
        app_id: "app_002",
        app_slug: "translator",
      },
    };

    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const decision = router.resolve({
      model: "@app/translator/chat",
      capability: "chat",
      streaming: false,
      plannerResult: plan,
    });

    expect(decision.routeMetadata.modelRefKind).toBe("app");
    expect(decision.routeMetadata.parsedRef.appSlug).toBe("translator");
    expect(decision.routeMetadata.routeEvent).toBeDefined();
    expect(decision.routeMetadata.routeEvent!.app_slug).toBe("translator");
    expect(decision.routeMetadata.routeEvent!.app_id).toBe("app_002");
  });
});

// ---------------------------------------------------------------------------
// 4. Telemetry payload excludes banned fields
// ---------------------------------------------------------------------------

describe("Telemetry: route event excludes banned fields", () => {
  it("FORBIDDEN_TELEMETRY_FIELDS contains all required banned fields", () => {
    const requiredBanned = [
      "prompt",
      "output",
      "audio",
      "file_path",
      "content",
      "messages",
    ];

    for (const field of requiredBanned) {
      expect(FORBIDDEN_TELEMETRY_FIELDS.has(field)).toBe(true);
    }
  });

  it("validateRouteEvent throws on prompt field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "responses",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      prompt: "this should not be here", // FORBIDDEN
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("prompt");
  });

  it("validateRouteEvent throws on output field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "responses",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      output: "this should not be here",
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("output");
  });

  it("validateRouteEvent throws on audio field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "audio",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      audio: new Uint8Array([1, 2, 3]),
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("audio");
  });

  it("validateRouteEvent throws on file_path field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "audio",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      file_path: "/tmp/secret.wav",
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("file_path");
  });

  it("validateRouteEvent throws on content field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "responses",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      content: "user message content",
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("content");
  });

  it("validateRouteEvent throws on messages field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "chat",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      messages: [{ role: "user", content: "secret" }],
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("messages");
  });

  it("validateRouteEvent throws on nested forbidden field", () => {
    const event = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "responses",
      final_locality: "cloud",
      engine: null,
      fallback_used: false,
      candidate_attempts: 1,
      nested: {
        deeply: {
          prompt: "leaked",
        },
      },
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(event)).toThrow("prompt");
  });

  it("buildRouteEvent produces a valid event without banned fields", () => {
    const attemptResult: AttemptLoopResult = {
      selectedAttempt: {
        index: 0,
        locality: "cloud",
        mode: "hosted_gateway",
        engine: "cloud",
        artifact: null,
        status: AttemptStatus.Selected,
        stage: AttemptStage.Inference,
        gate_results: [
          { code: "runtime_available", status: "passed" as const },
        ],
        reason: { code: "selected", message: "all gates passed" },
      },
      attempts: [
        {
          index: 0,
          locality: "cloud",
          mode: "hosted_gateway",
          engine: "cloud",
          artifact: null,
          status: AttemptStatus.Selected,
          stage: AttemptStage.Inference,
          gate_results: [
            { code: "runtime_available", status: "passed" as const },
          ],
          reason: { code: "selected", message: "all gates passed" },
        },
      ],
      fallbackUsed: false,
      fallbackTrigger: null,
      fromAttempt: null,
      toAttempt: null,
    };

    const event = buildRouteEvent({
      requestId: "req_test",
      capability: "responses",
      streaming: false,
      model: "phi-4-mini",
      modelRefKind: "model",
      policy: "cloud_first",
      plannerSource: "server",
      planId: "plan_001",
      attemptResult,
    });

    // Should not throw
    validateRouteEvent(event);

    // Verify structure
    expect(event.route_id).toMatch(/^route_/);
    expect(event.request_id).toBe("req_test");
    expect(event.capability).toBe("responses");
    expect(event.final_locality).toBe("cloud");
    expect(event.fallback_used).toBe(false);
    expect(event.candidate_attempts).toBe(1);
    expect(event.plan_id).toBe("plan_001");
    expect(event.model_ref).toBe("phi-4-mini");
    expect(event.model_ref_kind).toBe("model");

    // Verify no banned fields exist anywhere in the event
    const allKeys = collectAllKeys(event);
    for (const banned of [
      "prompt",
      "output",
      "audio",
      "file_path",
      "content",
      "messages",
    ]) {
      expect(allKeys.has(banned)).toBe(false);
    }
  });

  it("route event from RequestRouter excludes banned fields", () => {
    const plan: PlannerResult = {
      model: "phi-4-mini",
      capability: "responses",
      policy: "cloud_first",
      candidates: [
        {
          locality: "cloud",
          engine: "cloud",
          priority: 0,
          confidence: 1,
          reason: "cloud",
        },
      ],
      fallback_allowed: true,
      plan_id: "plan_001",
      planner_source: "server",
    };

    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const decision = router.resolve({
      model: "phi-4-mini",
      capability: "responses",
      streaming: false,
      plannerResult: plan,
    });

    const routeEvent = decision.routeMetadata.routeEvent!;
    expect(routeEvent).toBeDefined();

    // Should not throw
    validateRouteEvent(routeEvent);

    const allKeys = collectAllKeys(routeEvent);
    for (const banned of [
      "prompt",
      "output",
      "audio",
      "file_path",
      "content",
      "messages",
    ]) {
      expect(allKeys.has(banned)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// RequestRouter integration tests
// ---------------------------------------------------------------------------

describe("RequestRouter integration", () => {
  it("resolves with planner plan — cloud candidate selected", () => {
    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const plan = cloudPlannerResponse();
    const decision = router.resolve({
      model: "phi-4-mini",
      capability: "responses",
      streaming: false,
      plannerResult: plan,
    });

    expect(decision.locality).toBe("cloud");
    expect(decision.mode).toBe("hosted_gateway");
    expect(decision.endpoint).toBe("https://api.example.com");
    expect(decision.routeMetadata.plannerUsed).toBe(true);
    expect(decision.attemptResult.selectedAttempt).not.toBeNull();
  });

  it("resolves without planner plan — legacy direct cloud", () => {
    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const decision = router.resolve({
      model: "phi-4-mini",
      capability: "responses",
      streaming: false,
    });

    expect(decision.locality).toBe("cloud");
    expect(decision.mode).toBe("hosted_gateway");
    expect(decision.routeMetadata.plannerUsed).toBe(false);
  });

  it("local candidate falls back to cloud when no external endpoint", () => {
    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
      // No externalEndpoint
    });

    const plan = localFirstPlannerResponse();
    const decision = router.resolve({
      model: "gemma3-1b",
      capability: "responses",
      streaming: false,
      plannerResult: plan,
    });

    // Local should fail (no external endpoint), cloud selected
    expect(decision.locality).toBe("cloud");
    expect(decision.routeMetadata.plannerUsed).toBe(true);
    expect(decision.attemptResult.fallbackUsed).toBe(true);
    expect(decision.attemptResult.fallbackTrigger!.code).toBe(
      "runtime_unavailable",
    );
  });

  it("local candidate succeeds when external endpoint configured", () => {
    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
      externalEndpoint: "http://localhost:8080",
    });

    const plan = localFirstPlannerResponse();
    const decision = router.resolve({
      model: "gemma3-1b",
      capability: "responses",
      streaming: false,
      plannerResult: plan,
    });

    // Local should succeed with external endpoint
    expect(decision.locality).toBe("local");
    expect(decision.mode).toBe("external_endpoint");
    expect(decision.endpoint).toBe("http://localhost:8080");
  });

  it("private policy prevents fallback", () => {
    const router = new RequestRouter({
      cloudEndpoint: "https://api.example.com",
    });

    const plan: PlannerResult = {
      ...localFirstPlannerResponse(),
      policy: "private",
      fallback_allowed: false,
    };

    const decision = router.resolve({
      model: "gemma3-1b",
      capability: "responses",
      streaming: false,
      plannerResult: plan,
      routingPolicy: "private",
    });

    // Local fails, no fallback to cloud
    expect(decision.attemptResult.selectedAttempt).toBeNull();
    expect(decision.attemptResult.fallbackUsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PlannerClient tests
// ---------------------------------------------------------------------------

describe("PlannerClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns planner result on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      makeJsonResponse({
        model: "phi-4-mini",
        capability: "responses",
        policy: "cloud_first",
        candidates: [
          {
            locality: "cloud",
            engine: "cloud",
            priority: 0,
            confidence: 1,
            reason: "cloud",
          },
        ],
        fallback_allowed: true,
        plan_id: "plan_001",
        planner_source: "server",
      }),
    );

    const client = new PlannerClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
    });

    const plan = await client.getPlan({
      model: "phi-4-mini",
      capability: "responses",
    });

    expect(plan).not.toBeNull();
    expect(plan!.model).toBe("phi-4-mini");
    expect(plan!.candidates).toHaveLength(1);
    expect(plan!.plan_id).toBe("plan_001");
  });

  it("returns null on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("network failure"),
    );

    const client = new PlannerClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
    });

    const plan = await client.getPlan({
      model: "phi-4-mini",
      capability: "responses",
    });

    expect(plan).toBeNull();
  });

  it("returns null on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const client = new PlannerClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
    });

    const plan = await client.getPlan({
      model: "phi-4-mini",
      capability: "responses",
    });

    expect(plan).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const client = new PlannerClient({
      serverUrl: "https://api.example.com",
      apiKey: "test",
    });

    const plan = await client.getPlan({
      model: "phi-4-mini",
      capability: "responses",
    });

    expect(plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectAllKeys(obj: unknown): Set<string> {
  const keys = new Set<string>();

  function walk(val: unknown): void {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        keys.add(k);
        walk(v);
      }
    } else if (Array.isArray(val)) {
      for (const item of val) {
        walk(item);
      }
    }
  }

  walk(obj);
  return keys;
}
