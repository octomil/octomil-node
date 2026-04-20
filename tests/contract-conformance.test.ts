/**
 * Contract Conformance Test Suite
 *
 * Loads vendored contract fixtures from octomil-contracts and proves the Node SDK
 * can decode planner responses and route metadata correctly.
 *
 * Fixtures are in tests/fixtures/sdk_parity/ and represent the canonical SDK
 * behavior matrix across all platforms.
 */

import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, test, expect } from "vitest";
import {
  CandidateAttemptRunner,
  AttemptStatus,
  GateStatus,
} from "../src/runtime/routing/attempt-runner";
import type {
  CandidatePlan,
  RouteAttempt,
  CandidateGate,
} from "../src/runtime/routing/attempt-runner";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(__dirname, "fixtures", "sdk_parity");
const fixtures = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({
    name: f.replace(".json", ""),
    data: JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf-8")),
  }));

// Ensure we loaded fixtures
if (fixtures.length === 0) {
  throw new Error(`No fixtures found in ${FIXTURES_DIR} — test cannot proceed`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collects all object keys from a nested structure. */
function collectKeys(obj: unknown, keys: Set<string>): void {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      collectKeys(item, keys);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Contract Conformance", () => {
  describe("Planner Response Decoding", () => {
    test.each(fixtures)("$name: can decode planner response", ({ data }) => {
      const resp = data.planner_response;
      expect(resp.model).toBeDefined();
      expect(resp.candidates).toBeInstanceOf(Array);
      expect(typeof resp.fallback_allowed).toBe("boolean");

      for (const c of resp.candidates) {
        expect(c.locality).toMatch(/^(local|cloud)$/);
        expect(typeof c.priority).toBe("number");
        expect(typeof c.confidence).toBe("number");
        expect(typeof c.reason).toBe("string");

        for (const gate of c.gates ?? []) {
          expect(gate.code).toBeDefined();
          expect(typeof gate.required).toBe("boolean");
          expect(["server", "sdk", "runtime"]).toContain(gate.source);
        }
      }
    });

    test.each(fixtures.filter((f) => f.data.request.model?.startsWith?.("@app/")))(
      "$name: app refs carry app_resolution",
      ({ data }) => {
        expect(data.planner_response.app_resolution).toBeDefined();
        expect(data.planner_response.app_resolution).not.toBeNull();
        expect(data.planner_response.app_resolution.selected_model).toBe(
          data.planner_response.model,
        );
      },
    );
  });

  describe("Candidate Type Alignment", () => {
    test.each(fixtures)(
      "$name: candidates align with CandidatePlan interface",
      ({ data }) => {
        for (const c of data.planner_response.candidates) {
          // Validate the candidate matches CandidatePlan shape
          const plan: CandidatePlan = {
            locality: c.locality,
            engine: c.engine,
            artifact: c.artifact,
            gates: c.gates,
            priority: c.priority,
            confidence: c.confidence,
            reason: c.reason,
          };

          expect(plan.locality).toMatch(/^(local|cloud)$/);
          expect(typeof plan.priority).toBe("number");
          expect(typeof plan.confidence).toBe("number");

          if (plan.gates) {
            for (const gate of plan.gates) {
              const g: CandidateGate = gate;
              expect(typeof g.code).toBe("string");
              expect(typeof g.required).toBe("boolean");
              expect(["server", "sdk", "runtime"]).toContain(g.source);
            }
          }
        }
      },
    );
  });

  describe("Route Metadata Decoding", () => {
    test.each(fixtures.filter((f) => f.data.expected_route_metadata))(
      "$name: can decode route metadata",
      ({ data }) => {
        const meta = data.expected_route_metadata;
        expect(["selected", "unavailable", "failed"]).toContain(meta.status);

        for (const attempt of meta.attempts ?? []) {
          expect(typeof attempt.index).toBe("number");
          expect(["local", "cloud"]).toContain(attempt.locality);
          expect(["skipped", "failed", "selected"]).toContain(attempt.status);
          expect([
            "sdk_runtime",
            "hosted_gateway",
            "external_endpoint",
          ]).toContain(attempt.mode);
          expect([
            "policy",
            "prepare",
            "download",
            "verify",
            "load",
            "benchmark",
            "gate",
            "inference",
          ]).toContain(attempt.stage);
        }

        // Validate fallback structure
        if (meta.fallback) {
          expect(typeof meta.fallback.used).toBe("boolean");
          if (meta.fallback.used) {
            expect(typeof meta.fallback.from_attempt).toBe("number");
            expect(typeof meta.fallback.to_attempt).toBe("number");
            expect(meta.fallback.trigger).toBeDefined();
            expect(typeof meta.fallback.trigger.code).toBe("string");
            expect(typeof meta.fallback.trigger.stage).toBe("string");
            expect(typeof meta.fallback.trigger.message).toBe("string");
          } else {
            expect(meta.fallback.from_attempt).toBeNull();
            expect(meta.fallback.to_attempt).toBeNull();
            expect(meta.fallback.trigger).toBeNull();
          }
        }
      },
    );
  });

  describe("Route Metadata Attempt Types", () => {
    test.each(fixtures.filter((f) => f.data.expected_route_metadata))(
      "$name: attempts align with RouteAttempt interface",
      ({ data }) => {
        for (const attempt of data.expected_route_metadata.attempts ?? []) {
          // Validate the attempt matches RouteAttempt shape (key fields)
          const typed: Partial<RouteAttempt> = {
            index: attempt.index,
            locality: attempt.locality,
            mode: attempt.mode,
            engine: attempt.engine ?? null,
            status: attempt.status as AttemptStatus,
          };

          expect(typeof typed.index).toBe("number");
          expect(["local", "cloud"]).toContain(typed.locality);
          expect([
            "sdk_runtime",
            "hosted_gateway",
            "external_endpoint",
          ]).toContain(typed.mode);
          expect(Object.values(AttemptStatus).map(String)).toContain(
            typed.status,
          );
        }
      },
    );
  });

  describe("Policy Result Decoding", () => {
    test.each(fixtures.filter((f) => f.data.expected_policy_result))(
      "$name: can decode policy result",
      ({ data }) => {
        const policy = data.expected_policy_result;
        expect(typeof policy.cloud_allowed).toBe("boolean");
        expect(typeof policy.fallback_allowed).toBe("boolean");

        // Cross-check: if fallback_allowed=false in policy, planner response agrees
        if (!policy.fallback_allowed) {
          expect(data.planner_response.fallback_allowed).toBe(false);
        }
      },
    );
  });

  describe("Telemetry Safety", () => {
    const FORBIDDEN = new Set([
      "prompt",
      "input",
      "output",
      "audio",
      "file_path",
      "content",
      "messages",
    ]);

    test.each(fixtures)("$name: no forbidden keys in telemetry", ({ data }) => {
      const keys = new Set<string>();
      collectKeys(data.expected_telemetry ?? {}, keys);
      const violations = [...keys].filter((k) => FORBIDDEN.has(k));
      expect(violations).toEqual([]);
    });

    test.each(fixtures)("$name: telemetry has required fields", ({ data }) => {
      const telemetry = data.expected_telemetry;
      if (telemetry) {
        expect(telemetry.route_id).toBeDefined();
        expect(typeof telemetry.route_id).toBe("string");
        expect(telemetry.request_id).toBeDefined();
        expect(typeof telemetry.request_id).toBe("string");
        expect(telemetry.capability).toBeDefined();
        expect(telemetry.policy).toBeDefined();
        expect(typeof telemetry.fallback_used).toBe("boolean");
      }
    });
  });

  describe("Platform Rules — Node SDK", () => {
    test.each(fixtures.filter((f) => f.data.expected_route_metadata))(
      "$name: Node platform uses hosted_gateway or external_endpoint",
      ({ data }) => {
        // Node SDK should use hosted_gateway for cloud, sdk_runtime or
        // external_endpoint for local
        for (const attempt of data.expected_route_metadata.attempts ?? []) {
          if (attempt.locality === "cloud") {
            expect(attempt.mode).toBe("hosted_gateway");
          } else if (attempt.locality === "local") {
            expect(["sdk_runtime", "external_endpoint"]).toContain(
              attempt.mode,
            );
          }
        }
      },
    );
  });

  describe("Attempt Runner Integration", () => {
    test.each(
      fixtures.filter((f) => f.data.planner_response.candidates.length > 0),
    )("$name: runner can instantiate and process candidates", ({ data }) => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: data.planner_response.fallback_allowed,
      });
      expect(runner).toBeDefined();

      // Convert fixture candidates to CandidatePlan[]
      const candidates: CandidatePlan[] = data.planner_response.candidates.map(
        (c: Record<string, unknown>) => ({
          locality: c.locality as "local" | "cloud",
          engine: (c.engine as string) ?? undefined,
          artifact: c.artifact as
            | { artifact_id?: string; digest?: string }
            | undefined,
          gates: c.gates as CandidateGate[] | undefined,
          priority: c.priority as number,
          confidence: c.confidence as number,
          reason: c.reason as string,
        }),
      );

      // Runner should be able to process without throwing
      const result = runner.run(candidates);
      expect(result).toBeDefined();
      expect(result.attempts).toBeInstanceOf(Array);
      expect(result.attempts.length).toBeGreaterThan(0);
      expect(typeof result.fallbackUsed).toBe("boolean");

      // Verify attempt structure
      for (const attempt of result.attempts) {
        expect(typeof attempt.index).toBe("number");
        expect(["local", "cloud"]).toContain(attempt.locality);
        expect(Object.values(AttemptStatus).map(String)).toContain(
          attempt.status,
        );
      }
    });

    test.each(
      fixtures.filter((f) => f.data.planner_response.candidates.length > 0),
    )("$name: runner respects fallback_allowed setting", ({ data }) => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: data.planner_response.fallback_allowed,
      });

      const candidates: CandidatePlan[] = data.planner_response.candidates.map(
        (c: Record<string, unknown>) => ({
          locality: c.locality as "local" | "cloud",
          engine: (c.engine as string) ?? undefined,
          artifact: c.artifact as
            | { artifact_id?: string; digest?: string }
            | undefined,
          gates: c.gates as CandidateGate[] | undefined,
          priority: c.priority as number,
          confidence: c.confidence as number,
          reason: c.reason as string,
        }),
      );

      const result = runner.run(candidates);

      // When fallback is disallowed and first candidate fails,
      // no further candidates should be attempted
      if (
        !data.planner_response.fallback_allowed &&
        result.attempts.length > 0 &&
        result.attempts[0].status === AttemptStatus.Failed
      ) {
        // Should have stopped after first failure
        expect(result.attempts.length).toBe(1);
        expect(result.selectedAttempt).toBeNull();
      }
    });

    test.each(
      fixtures.filter((f) => f.data.planner_response.candidates.length > 0),
    )("$name: runner produces valid toRouteMetadataFields", ({ data }) => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: data.planner_response.fallback_allowed,
      });

      const candidates: CandidatePlan[] = data.planner_response.candidates.map(
        (c: Record<string, unknown>) => ({
          locality: c.locality as "local" | "cloud",
          engine: (c.engine as string) ?? undefined,
          artifact: c.artifact as
            | { artifact_id?: string; digest?: string }
            | undefined,
          gates: c.gates as CandidateGate[] | undefined,
          priority: c.priority as number,
          confidence: c.confidence as number,
          reason: c.reason as string,
        }),
      );

      runner.run(candidates);
      const fields = runner.toRouteMetadataFields();

      expect(fields).toBeDefined();
      expect(fields.attempts).toBeInstanceOf(Array);
      expect(typeof fields.fallback.used).toBe("boolean");

      if (fields.fallback.used) {
        expect(typeof fields.fallback.from_attempt).toBe("number");
        expect(typeof fields.fallback.to_attempt).toBe("number");
        expect(fields.fallback.trigger).not.toBeNull();
        expect(fields.fallback.trigger!.code).toBeDefined();
        expect(fields.fallback.trigger!.stage).toBeDefined();
        expect(fields.fallback.trigger!.message).toBeDefined();
      } else {
        expect(fields.fallback.from_attempt).toBeNull();
        expect(fields.fallback.to_attempt).toBeNull();
        expect(fields.fallback.trigger).toBeNull();
      }
    });
  });

  describe("Streaming Fallback Semantics", () => {
    test("pre-first-token: fallback allowed", () => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: true,
        streaming: true,
      });
      expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
    });

    test("post-first-token: fallback blocked", () => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: true,
        streaming: true,
      });
      expect(runner.shouldFallbackAfterInferenceError(true)).toBe(false);
    });

    test("non-streaming: fallback always allowed when policy allows", () => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: true,
        streaming: false,
      });
      expect(runner.shouldFallbackAfterInferenceError(false)).toBe(true);
      expect(runner.shouldFallbackAfterInferenceError(true)).toBe(true);
    });

    test("fallback disallowed: never falls back regardless of streaming state", () => {
      const runner = new CandidateAttemptRunner({
        fallbackAllowed: false,
        streaming: true,
      });
      expect(runner.shouldFallbackAfterInferenceError(false)).toBe(false);
    });
  });

  describe("Gate Status Enum Coverage", () => {
    test("GateStatus values match contract enum", () => {
      expect(GateStatus.Passed).toBe("passed");
      expect(GateStatus.Failed).toBe("failed");
      expect(GateStatus.Unknown).toBe("unknown");
      expect(GateStatus.NotRequired).toBe("not_required");
    });

    test("AttemptStatus values match contract enum", () => {
      expect(AttemptStatus.Skipped).toBe("skipped");
      expect(AttemptStatus.Failed).toBe("failed");
      expect(AttemptStatus.Selected).toBe("selected");
    });
  });
});
