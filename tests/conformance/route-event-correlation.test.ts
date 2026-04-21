/**
 * Conformance test: RouteEvent correlation fields and forbidden keys.
 *
 * Validates that:
 * 1. The RouteEvent interface contains all canonical cross-SDK correlation fields.
 * 2. FORBIDDEN_TELEMETRY_KEYS rejects user-content keys.
 * 3. stripForbiddenKeys() removes forbidden keys from arbitrary maps.
 * 4. validateRouteEvent() throws when forbidden keys are present.
 */

import { describe, it, expect } from "vitest";
import {
  type RouteEvent,
  FORBIDDEN_TELEMETRY_KEYS,
  stripForbiddenKeys,
  validateRouteEvent,
  buildRouteEvent,
} from "../../src/runtime/routing/route-event.js";
import { parseModelRef } from "../../src/runtime/routing/model-ref-parser.js";
import type { AttemptLoopResult } from "../../src/runtime/routing/attempt-runner.js";

// ---------------------------------------------------------------------------
// Canonical field presence
// ---------------------------------------------------------------------------

describe("RouteEvent canonical correlation fields", () => {
  it("buildRouteEvent produces all canonical fields", () => {
    const attemptResult: AttemptLoopResult = {
      selectedAttempt: {
        index: 0,
        locality: "cloud",
        mode: "hosted_gateway",
        engine: "cloud",
        artifact: null,
        status: "selected",
        stage: "inference",
        gate_results: [],
        reason: { code: "selected", message: "ok" },
      },
      attempts: [
        {
          index: 0,
          locality: "cloud",
          mode: "hosted_gateway",
          engine: "cloud",
          artifact: null,
          status: "selected",
          stage: "inference",
          gate_results: [],
          reason: { code: "selected", message: "ok" },
        },
      ],
      fallbackUsed: false,
      fallbackTrigger: null,
    };

    const event = buildRouteEvent({
      requestId: "req_test123",
      capability: "chat",
      streaming: false,
      model: "@app/my-app",
      modelRefKind: "app",
      policy: "auto",
      plannerSource: "server",
      planId: "plan_abc",
      attemptResult,
      deploymentId: "deploy_001",
      experimentId: "exp_002",
      variantId: "var_003",
      appId: "app_004",
      appSlug: "my-app",
    });

    // Core correlation identifiers
    expect(event.route_id).toBeDefined();
    expect(event.route_id).toMatch(/^route_/);
    expect(event.request_id).toBe("req_test123");

    // Deployment/experiment correlation
    expect(event.app_slug).toBe("my-app");
    expect(event.app_id).toBe("app_004");
    expect(event.deployment_id).toBe("deploy_001");
    expect(event.experiment_id).toBe("exp_002");
    expect(event.variant_id).toBe("var_003");

    // Locality and mode
    expect(event.selected_locality).toBe("cloud");
    expect(event.final_locality).toBe("cloud");
    expect(event.final_mode).toBe("hosted_gateway");

    // Fallback info
    expect(event.fallback_used).toBe(false);
    expect(event.fallback_trigger_code).toBeUndefined();
    expect(event.fallback_trigger_stage).toBeUndefined();

    // Candidate count
    expect(event.candidate_attempts).toBe(1);
  });

  it("selected_locality mirrors final_locality", () => {
    const attemptResult: AttemptLoopResult = {
      selectedAttempt: {
        index: 0,
        locality: "local",
        mode: "sdk_runtime",
        engine: "llamacpp",
        artifact: null,
        status: "selected",
        stage: "inference",
        gate_results: [],
        reason: { code: "selected", message: "ok" },
      },
      attempts: [],
      fallbackUsed: false,
      fallbackTrigger: null,
    };

    const event = buildRouteEvent({
      requestId: "req_local",
      capability: "chat",
      streaming: true,
      model: "llama3:8b",
      attemptResult,
    });

    expect(event.selected_locality).toBe(event.final_locality);
    expect(event.selected_locality).toBe("local");
    expect(event.final_mode).toBe("sdk_runtime");
  });
});

describe("parseModelRef canonical kinds", () => {
  it.each([
    ["gemma3-1b", "model"],
    ["@app/translator/chat", "app"],
    ["@capability/embeddings", "capability"],
    ["deploy_abc123", "deployment"],
    ["exp_v1/variant_a", "experiment"],
    ["alias:prod-chat", "alias"],
    ["", "default"],
    ["@bad/ref", "unknown"],
    ["https://example.com/model.gguf", "unknown"],
  ] as const)("classifies %s as %s", (model, expectedKind) => {
    expect(parseModelRef(model).kind).toBe(expectedKind);
  });

  it("keeps deployment IDs canonical including the deploy_ prefix", () => {
    expect(parseModelRef("deploy_abc123").deploymentId).toBe("deploy_abc123");
  });
});

// ---------------------------------------------------------------------------
// Forbidden telemetry keys
// ---------------------------------------------------------------------------

describe("FORBIDDEN_TELEMETRY_KEYS", () => {
  const expectedForbidden = [
    "prompt",
    "input",
    "output",
    "completion",
    "audio",
    "audio_bytes",
    "file_path",
    "text",
    "content",
    "messages",
    "system_prompt",
    "documents",
  ];

  it("contains all expected forbidden keys", () => {
    for (const key of expectedForbidden) {
      expect(FORBIDDEN_TELEMETRY_KEYS.has(key)).toBe(true);
    }
  });

  it("does not contain safe telemetry keys", () => {
    const safeKeys = [
      "route_id",
      "request_id",
      "model_ref",
      "engine",
      "fallback_used",
      "candidate_attempts",
      "deployment_id",
      "experiment_id",
    ];
    for (const key of safeKeys) {
      expect(FORBIDDEN_TELEMETRY_KEYS.has(key)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// stripForbiddenKeys
// ---------------------------------------------------------------------------

describe("stripForbiddenKeys", () => {
  it("removes forbidden keys from a map", () => {
    const input = {
      route_id: "route_abc",
      prompt: "secret user prompt",
      engine: "llamacpp",
      content: "user content",
      model_ref: "llama3",
      messages: [{ role: "user" }],
    };

    const stripped = stripForbiddenKeys(input);
    expect(stripped).toEqual({
      route_id: "route_abc",
      engine: "llamacpp",
      model_ref: "llama3",
    });
  });

  it("returns all keys when no forbidden keys present", () => {
    const input = {
      route_id: "route_xyz",
      request_id: "req_123",
      candidate_attempts: 3,
    };

    const stripped = stripForbiddenKeys(input);
    expect(stripped).toEqual(input);
  });

  it("removes forbidden keys recursively from nested maps", () => {
    const input = {
      route_id: "route_nested",
      metadata: {
        safe: true,
        prompt: "secret",
        attempts: [{ reason: { code: "gate_failed", content: "user text" } }],
      },
    };

    const stripped = stripForbiddenKeys(input);
    expect(stripped).toEqual({
      route_id: "route_nested",
      metadata: {
        safe: true,
        attempts: [{ reason: { code: "gate_failed" } }],
      },
    });
  });

  it("returns empty object when all keys are forbidden", () => {
    const input = {
      prompt: "hello",
      output: "world",
      content: "something",
    };

    const stripped = stripForbiddenKeys(input);
    expect(stripped).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// validateRouteEvent rejects contaminated events
// ---------------------------------------------------------------------------

describe("validateRouteEvent", () => {
  it("throws when a forbidden key is present", () => {
    const badEvent = {
      route_id: "route_1",
      request_id: "req_1",
      capability: "chat",
      final_locality: "cloud",
      selected_locality: "cloud",
      final_mode: "hosted_gateway",
      engine: "cloud",
      fallback_used: false,
      candidate_attempts: 1,
      prompt: "THIS SHOULD NOT BE HERE",
    } as unknown as RouteEvent;

    expect(() => validateRouteEvent(badEvent)).toThrow(
      /forbidden telemetry field.*prompt/,
    );
  });

  it("does not throw for a clean event", () => {
    const attemptResult: AttemptLoopResult = {
      selectedAttempt: {
        index: 0,
        locality: "cloud",
        mode: "hosted_gateway",
        engine: "cloud",
        artifact: null,
        status: "selected",
        stage: "inference",
        gate_results: [],
        reason: { code: "selected", message: "ok" },
      },
      attempts: [],
      fallbackUsed: false,
      fallbackTrigger: null,
    };

    const event = buildRouteEvent({
      requestId: "req_clean",
      capability: "responses",
      streaming: false,
      model: "gpt-4o",
      attemptResult,
    });

    expect(() => validateRouteEvent(event)).not.toThrow();
  });
});
