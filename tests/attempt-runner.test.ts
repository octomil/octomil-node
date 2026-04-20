import { describe, it, expect } from "vitest";
import {
  CandidateAttemptRunner,
  NoOpRuntimeChecker,
  NoOpGateEvaluator,
  AttemptStage,
  AttemptStatus,
  GateStatus,
  GATE_CODES,
} from "../src/runtime/routing/attempt-runner.js";
import type {
  GateCode,
  GateResult,
  RouteAttempt,
  RuntimeChecker,
  GateEvaluator,
  CandidateGate,
  CandidatePlan,
  AttemptLoopResult,
} from "../src/runtime/routing/attempt-runner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** RuntimeChecker that reports all engines as available. */
class AlwaysAvailableChecker implements RuntimeChecker {
  check(
    _engine: string | null,
    _locality: string,
  ): { available: boolean; reasonCode?: string } {
    return { available: true };
  }
}

/** RuntimeChecker that reports local engines as unavailable, cloud as available. */
class LocalUnavailableChecker implements RuntimeChecker {
  check(
    _engine: string | null,
    locality: string,
  ): { available: boolean; reasonCode?: string } {
    if (locality === "local") {
      return { available: false, reasonCode: "engine_not_installed" };
    }
    return { available: true };
  }
}

/** GateEvaluator that passes all gates. */
class AllPassGateEvaluator implements GateEvaluator {
  evaluate(
    gate: CandidateGate,
    _engine: string | null,
    _locality: string,
  ): GateResult {
    return {
      code: gate.code,
      status: GateStatus.Passed,
      threshold_number: gate.threshold_number,
    };
  }
}

/** GateEvaluator that fails a specific gate code. */
class FailSpecificGateEvaluator implements GateEvaluator {
  constructor(
    private readonly failCode: string,
    private readonly observed?: number,
  ) {}

  evaluate(
    gate: CandidateGate,
    _engine: string | null,
    _locality: string,
  ): GateResult {
    if (gate.code === this.failCode) {
      return {
        code: gate.code,
        status: GateStatus.Failed,
        observed_number: this.observed,
        threshold_number: gate.threshold_number,
        reason_code: `${this.failCode}_exceeded`,
      };
    }
    return {
      code: gate.code,
      status: GateStatus.Passed,
      threshold_number: gate.threshold_number,
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function localCandidate(overrides?: Partial<CandidatePlan>): CandidatePlan {
  return {
    locality: "local",
    engine: "llama.cpp",
    artifact: { artifact_id: "art_001", digest: "sha256:abc123" },
    gates: [
      { code: "artifact_verified", required: true, source: "server" },
      { code: "runtime_available", required: true, source: "server" },
      { code: "model_loads", required: true, source: "server" },
      {
        code: "min_tokens_per_second",
        required: true,
        threshold_number: 10.0,
        source: "server",
      },
    ],
    priority: 1,
    confidence: 0.95,
    reason: "local engine matches",
    ...overrides,
  };
}

function cloudCandidate(overrides?: Partial<CandidatePlan>): CandidatePlan {
  return {
    locality: "cloud",
    priority: 2,
    confidence: 0.8,
    reason: "cloud fallback",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Enum values
// ---------------------------------------------------------------------------

describe("AttemptStage", () => {
  it("has exactly the 8 contract-defined stages", () => {
    const stages = Object.values(AttemptStage);
    expect(stages).toEqual([
      "policy",
      "prepare",
      "download",
      "verify",
      "load",
      "benchmark",
      "gate",
      "inference",
    ]);
    expect(stages).toHaveLength(8);
  });
});

describe("AttemptStatus", () => {
  it("has exactly the 3 contract-defined statuses", () => {
    const statuses = Object.values(AttemptStatus);
    expect(statuses).toEqual(["skipped", "failed", "selected"]);
    expect(statuses).toHaveLength(3);
  });
});

describe("GateStatus", () => {
  it("has exactly the 4 contract-defined statuses", () => {
    const statuses = Object.values(GateStatus);
    expect(statuses).toEqual(["passed", "failed", "unknown", "not_required"]);
    expect(statuses).toHaveLength(4);
  });
});

describe("GATE_CODES", () => {
  it("contains exactly the 12 canonical gate codes", () => {
    expect(GATE_CODES).toEqual([
      "artifact_verified",
      "runtime_available",
      "model_loads",
      "context_fits",
      "modality_supported",
      "tool_support",
      "min_tokens_per_second",
      "max_ttft_ms",
      "max_error_rate",
      "min_free_memory_bytes",
      "min_free_storage_bytes",
      "benchmark_fresh",
    ]);
    expect(GATE_CODES).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// NoOp defaults
// ---------------------------------------------------------------------------

describe("NoOpRuntimeChecker", () => {
  it("reports cloud as available", () => {
    const checker = new NoOpRuntimeChecker();
    expect(checker.check(null, "cloud")).toEqual({ available: true });
  });

  it("reports local as unavailable", () => {
    const checker = new NoOpRuntimeChecker();
    const result = checker.check("llama.cpp", "local");
    expect(result.available).toBe(false);
    expect(result.reasonCode).toBe("no_local_runtime_checker");
  });
});

describe("NoOpGateEvaluator", () => {
  it("returns not_required for non-required gates", () => {
    const evaluator = new NoOpGateEvaluator();
    const gate: CandidateGate = {
      code: "min_tokens_per_second",
      required: false,
      source: "server",
    };
    const result = evaluator.evaluate(gate, null, "cloud");
    expect(result.status).toBe(GateStatus.NotRequired);
  });

  it("returns unknown for required gates", () => {
    const evaluator = new NoOpGateEvaluator();
    const gate: CandidateGate = {
      code: "model_loads",
      required: true,
      source: "server",
    };
    const result = evaluator.evaluate(gate, null, "cloud");
    expect(result.status).toBe(GateStatus.Unknown);
  });
});

// ---------------------------------------------------------------------------
// Single candidate selected
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — single candidate selected", () => {
  it("selects a single local candidate when all gates pass", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe(AttemptStatus.Selected);
    expect(result.selectedAttempt!.stage).toBe(AttemptStage.Inference);
    expect(result.selectedAttempt!.locality).toBe("local");
    expect(result.selectedAttempt!.mode).toBe("sdk_runtime");
    expect(result.selectedAttempt!.engine).toBe("llama.cpp");
    expect(result.selectedAttempt!.index).toBe(0);
    expect(result.attempts).toHaveLength(1);
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
    expect(result.fromAttempt).toBeNull();
    expect(result.toAttempt).toBeNull();
  });

  it("selects a single cloud candidate", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([cloudCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe(AttemptStatus.Selected);
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.engine).toBeNull();
  });

  it("includes artifact info when present on candidate", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const artifact = result.selectedAttempt!.artifact;
    expect(artifact).not.toBeNull();
    expect(artifact!.id).toBe("art_001");
    expect(artifact!.digest).toBe("sha256:abc123");
    expect(artifact!.cache.status).toBe("not_applicable");
    expect(artifact!.cache.managed_by).toBeNull();
  });

  it("has null artifact when candidate has no artifact", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([cloudCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt!.artifact).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate results on selected attempt
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — gate results", () => {
  it("includes runtime_available as passed in gate results", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const gateResults = result.selectedAttempt!.gate_results;
    const runtimeGate = gateResults.find((g) => g.code === "runtime_available");
    expect(runtimeGate).toBeDefined();
    expect(runtimeGate!.status).toBe(GateStatus.Passed);
  });

  it("evaluates all non-runtime_available gates from the candidate", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const gateResults = result.selectedAttempt!.gate_results;
    // runtime_available (from runtime check) + artifact_verified + model_loads + min_tokens_per_second
    // runtime_available in the gates list is skipped (already checked), so 4 total
    expect(gateResults).toHaveLength(4);

    const codes = gateResults.map((g) => g.code);
    expect(codes).toContain("runtime_available");
    expect(codes).toContain("artifact_verified");
    expect(codes).toContain("model_loads");
    expect(codes).toContain("min_tokens_per_second");
  });
});

// ---------------------------------------------------------------------------
// Runtime unavailable triggers fallback to cloud
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — runtime unavailable fallback", () => {
  it("falls back to cloud when local runtime is unavailable", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true });
    const candidates = [localCandidate(), cloudCandidate()];
    const result = runner.run(candidates, {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.selectedAttempt!.mode).toBe("hosted_gateway");
    expect(result.selectedAttempt!.index).toBe(1);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe(AttemptStatus.Failed);
    expect(result.attempts[0]!.stage).toBe(AttemptStage.Prepare);
    expect(result.attempts[1]!.status).toBe(AttemptStatus.Selected);

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger!.code).toBe("runtime_unavailable");
    expect(result.fallbackTrigger!.stage).toBe("prepare");
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
  });

  it("records runtime_available as failed in the failed attempt gate results", () => {
    const runner = new CandidateAttemptRunner();
    const candidates = [localCandidate(), cloudCandidate()];
    const result = runner.run(candidates, {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const failedAttempt = result.attempts[0]!;
    expect(failedAttempt.gate_results).toHaveLength(1);
    expect(failedAttempt.gate_results[0]!.code).toBe("runtime_available");
    expect(failedAttempt.gate_results[0]!.status).toBe(GateStatus.Failed);
    expect(failedAttempt.gate_results[0]!.reason_code).toBe(
      "engine_not_installed",
    );
  });
});

// ---------------------------------------------------------------------------
// Gate failure triggers fallback
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — gate failure fallback", () => {
  it("falls back to cloud when a required gate fails", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true });
    const candidates = [
      localCandidate({
        gates: [
          { code: "runtime_available", required: true, source: "server" },
          {
            code: "max_ttft_ms",
            required: true,
            threshold_number: 2000,
            source: "server",
          },
        ],
      }),
      cloudCandidate(),
    ];
    const result = runner.run(candidates, {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new FailSpecificGateEvaluator("max_ttft_ms", 3200),
    });

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
    expect(result.selectedAttempt!.index).toBe(1);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe(AttemptStatus.Failed);
    expect(result.attempts[0]!.stage).toBe(AttemptStage.Gate);

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger!.code).toBe("gate_failed");
    expect(result.fallbackTrigger!.stage).toBe("gate");
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
  });

  it("records gate results including the failed gate with observed/threshold", () => {
    const runner = new CandidateAttemptRunner();
    const candidates = [
      localCandidate({
        gates: [
          { code: "artifact_verified", required: true, source: "server" },
          { code: "runtime_available", required: true, source: "server" },
          {
            code: "max_ttft_ms",
            required: true,
            threshold_number: 2000,
            source: "server",
          },
        ],
      }),
      cloudCandidate(),
    ];
    const result = runner.run(candidates, {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new FailSpecificGateEvaluator("max_ttft_ms", 3200),
    });

    const failedAttempt = result.attempts[0]!;
    const ttftGate = failedAttempt.gate_results.find(
      (g) => g.code === "max_ttft_ms",
    );
    expect(ttftGate).toBeDefined();
    expect(ttftGate!.status).toBe(GateStatus.Failed);
    expect(ttftGate!.observed_number).toBe(3200);
    expect(ttftGate!.threshold_number).toBe(2000);
    expect(ttftGate!.reason_code).toBe("max_ttft_ms_exceeded");
  });
});

// ---------------------------------------------------------------------------
// Fallback disabled (private policy)
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — fallback disabled", () => {
  it("fails without trying next candidate when fallback is disabled", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false });
    const candidates = [localCandidate(), cloudCandidate()];
    const result = runner.run(candidates, {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe(AttemptStatus.Failed);
    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
    expect(result.fromAttempt).toBeNull();
    expect(result.toAttempt).toBeNull();
  });

  it("fails without trying next when a gate fails and fallback disabled", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false });
    const candidates = [
      localCandidate({
        gates: [
          {
            code: "max_ttft_ms",
            required: true,
            threshold_number: 2000,
            source: "server",
          },
        ],
      }),
      cloudCandidate(),
    ];
    const result = runner.run(candidates, {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new FailSpecificGateEvaluator("max_ttft_ms", 3200),
    });

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.stage).toBe(AttemptStage.Gate);
    expect(result.fallbackUsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Attempt indices are sequential
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — sequential indices", () => {
  it("assigns sequential zero-based indices to attempts", () => {
    const runner = new CandidateAttemptRunner();
    const candidates = [
      localCandidate({ engine: "engine-a" }),
      localCandidate({ engine: "engine-b", priority: 2 }),
      cloudCandidate({ priority: 3 }),
    ];

    // Both local engines are unavailable, cloud selected
    const result = runner.run(candidates, {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]!.index).toBe(0);
    expect(result.attempts[1]!.index).toBe(1);
    expect(result.attempts[2]!.index).toBe(2);
  });

  it("stops after first selected — no further attempts processed", () => {
    const runner = new CandidateAttemptRunner();
    const candidates = [
      localCandidate(),
      cloudCandidate(),
      cloudCandidate({ priority: 3 }),
    ];
    const result = runner.run(candidates, {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.selectedAttempt!.index).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Output shape matches contract
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — output shape matches contract", () => {
  it("RouteAttempt has all required fields from route_attempt.schema.json", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const attempt = result.attempts[0]!;

    // Required fields per schema
    expect(typeof attempt.index).toBe("number");
    expect(["local", "cloud"]).toContain(attempt.locality);
    expect(["sdk_runtime", "hosted_gateway", "external_endpoint"]).toContain(
      attempt.mode,
    );
    expect(["skipped", "failed", "selected"]).toContain(attempt.status);
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
    expect(attempt.reason).toHaveProperty("code");
    expect(attempt.reason).toHaveProperty("message");
    expect(typeof attempt.reason.code).toBe("string");
    expect(typeof attempt.reason.message).toBe("string");

    // Optional fields
    expect(Array.isArray(attempt.gate_results)).toBe(true);
    // engine can be string or null
    expect(attempt.engine === null || typeof attempt.engine === "string").toBe(
      true,
    );
    // artifact can be object or null
    expect(
      attempt.artifact === null || typeof attempt.artifact === "object",
    ).toBe(true);
  });

  it("GateResult has all required fields from the schema", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    for (const gate of result.attempts[0]!.gate_results) {
      expect(typeof gate.code).toBe("string");
      expect(["passed", "failed", "unknown", "not_required"]).toContain(
        gate.status,
      );
    }
  });

  it("AttemptLoopResult has the correct shape", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result).toHaveProperty("selectedAttempt");
    expect(result).toHaveProperty("attempts");
    expect(result).toHaveProperty("fallbackUsed");
    expect(result).toHaveProperty("fallbackTrigger");
    expect(result).toHaveProperty("fromAttempt");
    expect(result).toHaveProperty("toAttempt");
    expect(Array.isArray(result.attempts)).toBe(true);
    expect(typeof result.fallbackUsed).toBe("boolean");
  });

  it("FallbackTrigger matches the contract shape", () => {
    const runner = new CandidateAttemptRunner();
    const candidates = [localCandidate(), cloudCandidate()];
    const result = runner.run(candidates, {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.fallbackTrigger).not.toBeNull();
    expect(result.fallbackTrigger).toHaveProperty("code");
    expect(result.fallbackTrigger).toHaveProperty("stage");
    expect(result.fallbackTrigger).toHaveProperty("message");
    expect(typeof result.fallbackTrigger!.code).toBe("string");
    expect(typeof result.fallbackTrigger!.stage).toBe("string");
    expect(typeof result.fallbackTrigger!.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// toRouteMetadataFields
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner.toRouteMetadataFields", () => {
  it("returns structured fallback metadata matching contract shape", () => {
    const runner = new CandidateAttemptRunner();
    const candidates = [localCandidate(), cloudCandidate()];
    runner.run(candidates, {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const meta = runner.toRouteMetadataFields();

    expect(meta.attempts).toHaveLength(2);
    expect(meta.fallback.used).toBe(true);
    expect(meta.fallback.from_attempt).toBe(0);
    expect(meta.fallback.to_attempt).toBe(1);
    expect(meta.fallback.trigger).not.toBeNull();
    expect(meta.fallback.trigger!.code).toBe("runtime_unavailable");
  });

  it("returns no fallback when first candidate succeeds", () => {
    const runner = new CandidateAttemptRunner();
    runner.run([localCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    const meta = runner.toRouteMetadataFields();

    expect(meta.attempts).toHaveLength(1);
    expect(meta.fallback.used).toBe(false);
    expect(meta.fallback.from_attempt).toBeNull();
    expect(meta.fallback.to_attempt).toBeNull();
    expect(meta.fallback.trigger).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — edge cases", () => {
  it("returns no selection when candidates list is empty", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(0);
    expect(result.fallbackUsed).toBe(false);
  });

  it("handles candidates with no gates", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([cloudCandidate({ gates: [] })], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.status).toBe(AttemptStatus.Selected);
    // runtime_available is always added
    expect(result.selectedAttempt!.gate_results).toHaveLength(1);
    expect(result.selectedAttempt!.gate_results[0]!.code).toBe(
      "runtime_available",
    );
  });

  it("handles candidates with undefined gates", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([cloudCandidate()], {
      runtimeChecker: new AlwaysAvailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.gate_results).toHaveLength(1);
  });

  it("uses default NoOp checkers when none provided", () => {
    const runner = new CandidateAttemptRunner();
    // Cloud candidate should succeed with default NoOp (cloud always available)
    const result = runner.run([cloudCandidate()]);

    expect(result.selectedAttempt).not.toBeNull();
    expect(result.selectedAttempt!.locality).toBe("cloud");
  });

  it("local candidate fails with default NoOp checker", () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false });
    const result = runner.run([localCandidate()]);

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.status).toBe(AttemptStatus.Failed);
  });

  it("all candidates fail when all are unavailable", () => {
    const nothingAvailable: RuntimeChecker = {
      check: () => ({ available: false, reasonCode: "nothing_works" }),
    };
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate(), cloudCandidate()], {
      runtimeChecker: nothingAvailable,
    });

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.status).toBe(AttemptStatus.Failed);
    expect(result.attempts[1]!.status).toBe(AttemptStatus.Failed);
    expect(result.fallbackUsed).toBe(false);
  });

  it("streaming flag is stored on the runner", () => {
    const runner = new CandidateAttemptRunner({ streaming: true });
    expect(runner.streaming).toBe(true);
  });

  it("streaming defaults to false", () => {
    const runner = new CandidateAttemptRunner();
    expect(runner.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract fixture alignment
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner — contract fixture alignment", () => {
  it("matches attempt_local_gate_pass fixture pattern", () => {
    // Mirrors: attempt_local_gate_pass.json
    const runner = new CandidateAttemptRunner();
    const result = runner.run(
      [
        localCandidate({
          engine: "mlx-lm",
          artifact: { artifact_id: "art_001", digest: "sha256:abc123" },
          gates: [
            { code: "artifact_verified", required: true, source: "server" },
            { code: "runtime_available", required: true, source: "server" },
            { code: "model_loads", required: true, source: "server" },
            {
              code: "min_tokens_per_second",
              required: true,
              threshold_number: 10.0,
              source: "server",
            },
          ],
        }),
      ],
      {
        runtimeChecker: new AlwaysAvailableChecker(),
        gateEvaluator: new AllPassGateEvaluator(),
      },
    );

    expect(result.attempts).toHaveLength(1);
    const attempt = result.attempts[0]!;
    expect(attempt.index).toBe(0);
    expect(attempt.locality).toBe("local");
    expect(attempt.mode).toBe("sdk_runtime");
    expect(attempt.engine).toBe("mlx-lm");
    expect(attempt.status).toBe("selected");
    expect(attempt.stage).toBe("inference");
    expect(attempt.reason.code).toBe("selected");
    expect(result.fallbackUsed).toBe(false);
  });

  it("matches attempt_local_unavailable_cloud_fallback fixture pattern", () => {
    // Mirrors: attempt_local_unavailable_cloud_fallback.json
    const runner = new CandidateAttemptRunner();
    const result = runner.run(
      [localCandidate({ engine: "mlx-lm" }), cloudCandidate()],
      {
        runtimeChecker: new LocalUnavailableChecker(),
        gateEvaluator: new AllPassGateEvaluator(),
      },
    );

    expect(result.attempts).toHaveLength(2);

    // First attempt: local failed
    const first = result.attempts[0]!;
    expect(first.index).toBe(0);
    expect(first.locality).toBe("local");
    expect(first.mode).toBe("sdk_runtime");
    expect(first.engine).toBe("mlx-lm");
    expect(first.status).toBe("failed");
    expect(first.stage).toBe("prepare");
    expect(first.gate_results[0]!.code).toBe("runtime_available");
    expect(first.gate_results[0]!.status).toBe("failed");

    // Second attempt: cloud selected
    const second = result.attempts[1]!;
    expect(second.index).toBe(1);
    expect(second.locality).toBe("cloud");
    expect(second.mode).toBe("hosted_gateway");
    expect(second.engine).toBeNull();
    expect(second.status).toBe("selected");
    expect(second.stage).toBe("inference");

    expect(result.fallbackUsed).toBe(true);
    expect(result.fromAttempt).toBe(0);
    expect(result.toAttempt).toBe(1);
    expect(result.fallbackTrigger!.code).toBe("runtime_unavailable");
    expect(result.fallbackTrigger!.stage).toBe("prepare");
  });

  it("matches attempt_private_local_fail_no_cloud fixture pattern", () => {
    // Mirrors: attempt_private_local_fail_no_cloud.json
    const runner = new CandidateAttemptRunner({ fallbackAllowed: false });
    const result = runner.run(
      [localCandidate({ engine: "mlx-lm" }), cloudCandidate()],
      {
        runtimeChecker: new LocalUnavailableChecker(),
        gateEvaluator: new AllPassGateEvaluator(),
      },
    );

    expect(result.selectedAttempt).toBeNull();
    expect(result.attempts).toHaveLength(1);

    const attempt = result.attempts[0]!;
    expect(attempt.index).toBe(0);
    expect(attempt.locality).toBe("local");
    expect(attempt.status).toBe("failed");
    expect(attempt.stage).toBe("prepare");

    expect(result.fallbackUsed).toBe(false);
    expect(result.fallbackTrigger).toBeNull();
    expect(result.fromAttempt).toBeNull();
    expect(result.toAttempt).toBeNull();
  });

  it("matches attempt_ttft_gate_fail_cloud_fallback fixture pattern", () => {
    // Mirrors: attempt_ttft_gate_fail_cloud_fallback.json
    const runner = new CandidateAttemptRunner();
    const result = runner.run(
      [
        localCandidate({
          engine: "llama.cpp",
          artifact: { artifact_id: "art_002", digest: "sha256:def456" },
          gates: [
            { code: "artifact_verified", required: true, source: "server" },
            { code: "runtime_available", required: true, source: "server" },
            { code: "model_loads", required: true, source: "server" },
            {
              code: "max_ttft_ms",
              required: true,
              threshold_number: 2000,
              source: "server",
            },
          ],
        }),
        cloudCandidate(),
      ],
      {
        runtimeChecker: new AlwaysAvailableChecker(),
        gateEvaluator: new FailSpecificGateEvaluator("max_ttft_ms", 3200),
      },
    );

    expect(result.attempts).toHaveLength(2);

    // First: local failed at gate stage
    const first = result.attempts[0]!;
    expect(first.status).toBe("failed");
    expect(first.stage).toBe("gate");
    const ttftGate = first.gate_results.find((g) => g.code === "max_ttft_ms");
    expect(ttftGate!.status).toBe("failed");
    expect(ttftGate!.observed_number).toBe(3200);
    expect(ttftGate!.threshold_number).toBe(2000);

    // Second: cloud selected
    const second = result.attempts[1]!;
    expect(second.status).toBe("selected");
    expect(second.locality).toBe("cloud");

    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger!.code).toBe("gate_failed");
    expect(result.fallbackTrigger!.stage).toBe("gate");
  });
});

// ---------------------------------------------------------------------------
// getAttempts accessor
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner.getAttempts", () => {
  it("returns empty array before run is called", () => {
    const runner = new CandidateAttemptRunner();
    expect(runner.getAttempts()).toEqual([]);
  });

  it("returns the same attempts as the run result", () => {
    const runner = new CandidateAttemptRunner();
    const result = runner.run([localCandidate(), cloudCandidate()], {
      runtimeChecker: new LocalUnavailableChecker(),
      gateEvaluator: new AllPassGateEvaluator(),
    });

    expect(runner.getAttempts()).toEqual(result.attempts);
  });
});

// ---------------------------------------------------------------------------
// runWithInference
// ---------------------------------------------------------------------------

describe("CandidateAttemptRunner.runWithInference", () => {
  it("falls back after a non-streaming inference error", async () => {
    const runner = new CandidateAttemptRunner({ fallbackAllowed: true });
    const result = await runner.runWithInference(
      [localCandidate(), cloudCandidate()],
      {
        runtimeChecker: new AlwaysAvailableChecker(),
        gateEvaluator: new AllPassGateEvaluator(),
        executeCandidate: async (candidate) => {
          if (candidate.locality === "local") {
            throw new Error("model load failed");
          }
          return "cloud-ok";
        },
      },
    );

    expect(result.value).toBe("cloud-ok");
    expect(result.fallbackUsed).toBe(true);
    expect(result.fallbackTrigger?.code).toBe("inference_error");
    expect(result.attempts[0]?.stage).toBe(AttemptStage.Inference);
    expect(result.attempts[0]?.status).toBe(AttemptStatus.Failed);
    expect(result.selectedAttempt?.locality).toBe("cloud");
  });

  it("does not fall back after streaming output was emitted", async () => {
    let emitted = false;
    const runner = new CandidateAttemptRunner({
      fallbackAllowed: true,
      streaming: true,
    });
    const result = await runner.runWithInference(
      [localCandidate(), cloudCandidate()],
      {
        runtimeChecker: new AlwaysAvailableChecker(),
        executeCandidate: async () => {
          emitted = true;
          throw new Error("stream interrupted");
        },
        firstOutputEmitted: () => emitted,
      },
    );

    expect(result.selectedAttempt).toBeNull();
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.reason.code).toBe(
      "inference_error_after_first_output",
    );
  });
});
