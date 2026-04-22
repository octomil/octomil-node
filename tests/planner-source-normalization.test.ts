/**
 * Tests for planner source normalization.
 *
 * Verifies that all SDK output boundaries emit only canonical planner_source
 * values: "server", "cache", "offline". Non-canonical aliases must be
 * normalized before they reach the wire.
 */

import { describe, it, expect } from "vitest";
import {
  normalizePlannerSource,
  CANONICAL_PLANNER_SOURCES,
  type PlannerSource,
} from "../src/planner/types.js";
import { buildRouteEvent } from "../src/runtime/routing/route-event.js";
import type { AttemptLoopResult } from "../src/runtime/routing/attempt-runner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal AttemptLoopResult for buildRouteEvent. */
function stubAttemptResult(): AttemptLoopResult {
  return {
    attempts: [
      {
        index: 0,
        locality: "cloud",
        mode: "hosted_gateway",
        engine: "cloud",
        status: "selected",
        stage: "selected",
        gate_results: [],
        reason: { code: "selected", message: "selected" },
        artifact: null,
      },
    ],
    selectedAttempt: {
      index: 0,
      locality: "cloud",
      mode: "hosted_gateway",
      engine: "cloud",
      status: "selected",
      stage: "selected",
      gate_results: [],
      reason: { code: "selected", message: "selected" },
      artifact: null,
    },
    fallbackUsed: false,
  };
}

// ---------------------------------------------------------------------------
// normalizePlannerSource
// ---------------------------------------------------------------------------

describe("normalizePlannerSource", () => {
  it("passes through canonical values unchanged", () => {
    const canonical: PlannerSource[] = ["server", "cache", "offline"];
    for (const value of canonical) {
      expect(normalizePlannerSource(value)).toBe(value);
    }
  });

  it("maps 'local_default' to 'offline'", () => {
    expect(normalizePlannerSource("local_default")).toBe("offline");
  });

  it("maps 'server_plan' to 'server'", () => {
    expect(normalizePlannerSource("server_plan")).toBe("server");
  });

  it("maps 'cached' to 'cache'", () => {
    expect(normalizePlannerSource("cached")).toBe("cache");
  });

  it("maps 'fallback' to 'offline'", () => {
    expect(normalizePlannerSource("fallback")).toBe("offline");
  });

  it("maps 'none' to 'offline'", () => {
    expect(normalizePlannerSource("none")).toBe("offline");
  });

  it("maps 'local_benchmark' to 'offline'", () => {
    expect(normalizePlannerSource("local_benchmark")).toBe("offline");
  });

  it("passes through unknown values as-is", () => {
    expect(normalizePlannerSource("custom_source")).toBe("custom_source");
  });
});

// ---------------------------------------------------------------------------
// CANONICAL_PLANNER_SOURCES
// ---------------------------------------------------------------------------

describe("CANONICAL_PLANNER_SOURCES", () => {
  it("contains exactly server, cache, offline", () => {
    expect(CANONICAL_PLANNER_SOURCES.size).toBe(3);
    expect(CANONICAL_PLANNER_SOURCES.has("server")).toBe(true);
    expect(CANONICAL_PLANNER_SOURCES.has("cache")).toBe(true);
    expect(CANONICAL_PLANNER_SOURCES.has("offline")).toBe(true);
  });

  it("does not contain non-canonical values", () => {
    const nonCanonical = ["local_default", "server_plan", "cached", "fallback", "none"];
    for (const v of nonCanonical) {
      expect(CANONICAL_PLANNER_SOURCES.has(v as PlannerSource)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildRouteEvent planner_source normalization
// ---------------------------------------------------------------------------

describe("buildRouteEvent planner_source normalization", () => {
  it("normalizes 'server_plan' to 'server' in route event", () => {
    const event = buildRouteEvent({
      requestId: "test-1",
      capability: "chat",
      streaming: false,
      model: "test-model",
      plannerSource: "server_plan",
      attemptResult: stubAttemptResult(),
    });
    expect(event.planner_source).toBe("server");
  });

  it("normalizes 'local_default' to 'offline' in route event", () => {
    const event = buildRouteEvent({
      requestId: "test-2",
      capability: "chat",
      streaming: false,
      model: "test-model",
      plannerSource: "local_default",
      attemptResult: stubAttemptResult(),
    });
    expect(event.planner_source).toBe("offline");
  });

  it("normalizes 'none' to 'offline' in route event", () => {
    const event = buildRouteEvent({
      requestId: "test-3",
      capability: "chat",
      streaming: false,
      model: "test-model",
      plannerSource: "none",
      attemptResult: stubAttemptResult(),
    });
    expect(event.planner_source).toBe("offline");
  });

  it("passes through canonical 'server' unchanged", () => {
    const event = buildRouteEvent({
      requestId: "test-4",
      capability: "chat",
      streaming: false,
      model: "test-model",
      plannerSource: "server",
      attemptResult: stubAttemptResult(),
    });
    expect(event.planner_source).toBe("server");
  });

  it("leaves planner_source undefined when input is undefined", () => {
    const event = buildRouteEvent({
      requestId: "test-5",
      capability: "chat",
      streaming: false,
      model: "test-model",
      attemptResult: stubAttemptResult(),
    });
    expect(event.planner_source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-SDK serialization shape
// ---------------------------------------------------------------------------

describe("RouteEvent serialization shape", () => {
  it("planner_source is always a canonical value when set", () => {
    const aliases = [
      "server_plan",
      "local_default",
      "cached",
      "fallback",
      "none",
      "local_benchmark",
    ];

    for (const alias of aliases) {
      const event = buildRouteEvent({
        requestId: `shape-${alias}`,
        capability: "chat",
        streaming: false,
        model: "test-model",
        plannerSource: alias,
        attemptResult: stubAttemptResult(),
      });
      expect(
        CANONICAL_PLANNER_SOURCES.has(event.planner_source as PlannerSource),
      ).toBe(true);
    }
  });
});
