/**
 * CandidateAttemptRunner — per-request candidate evaluation loop.
 *
 * Mirrors the Python reference implementation. Iterates over planner-provided
 * candidates, checking runtime availability and evaluating gates. Produces a
 * structured attempt log that feeds into RouteMetadata.
 *
 * The Node SDK is server-side, so primary modes are `hosted_gateway` (cloud)
 * and `external_endpoint` (user's local serve instance). `sdk_runtime` is
 * supported for ONNX-backed local inference when an engine is installed.
 *
 * Gate taxonomy (v1.19.0):
 * - readiness gates: artifact_verified, runtime_available, model_loads,
 *   context_fits, modality_supported, tool_support — pre_inference
 * - performance gates: min_tokens_per_second, max_error_rate,
 *   min_free_memory_bytes, min_free_storage_bytes, benchmark_fresh — pre_inference;
 *   max_ttft_ms — during_inference
 * - output_quality gates: schema_valid, tool_call_valid, safety_passed,
 *   evaluator_score_min, json_parseable, max_refusal_rate — post_inference
 */

// ---------------------------------------------------------------------------
// Enums — match contract enum values exactly
//
// TODO(contracts): These enums (AttemptStage, AttemptStatus, GateStatus) and
// the GATE_CODES array are hand-maintained to match the contract. Replace with
// generated equivalents from octomil-contracts codegen when SDK type adoption
// lands. The browser SDK has identical string unions (not enums) — reconcile
// enum vs union representation when adopting generated types.
// ---------------------------------------------------------------------------

/** Stage at which an attempt resolved (succeeded or failed). */
export enum AttemptStage {
  Policy = "policy",
  Prepare = "prepare",
  Download = "download",
  Verify = "verify",
  Load = "load",
  Benchmark = "benchmark",
  Gate = "gate",
  Inference = "inference",
  OutputQuality = "output_quality",
}

/** Outcome of an attempt. */
export enum AttemptStatus {
  Skipped = "skipped",
  Failed = "failed",
  Selected = "selected",
}

/** Outcome of a single gate evaluation. */
export enum GateStatus {
  Passed = "passed",
  Failed = "failed",
  Unknown = "unknown",
  NotRequired = "not_required",
}

// ---------------------------------------------------------------------------
// Gate codes — the 18 canonical codes from the contract (v1.19.0)
// ---------------------------------------------------------------------------

export const GATE_CODES = [
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
  "schema_valid",
  "tool_call_valid",
  "safety_passed",
  "evaluator_score_min",
  "json_parseable",
  "max_refusal_rate",
] as const;

export type GateCode = (typeof GATE_CODES)[number];

// ---------------------------------------------------------------------------
// Gate classification — canonical map from gate code to class and phase
// ---------------------------------------------------------------------------

export type GateClassValue = "readiness" | "performance" | "output_quality";
export type EvaluationPhaseValue =
  | "pre_inference"
  | "during_inference"
  | "post_inference";

export interface GateClassification {
  gate_class: GateClassValue;
  evaluation_phase: EvaluationPhaseValue;
  blocking_default: boolean;
}

export const GATE_CLASSIFICATION: Record<string, GateClassification> = {
  artifact_verified: {
    gate_class: "readiness",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  runtime_available: {
    gate_class: "readiness",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  model_loads: {
    gate_class: "readiness",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  context_fits: {
    gate_class: "readiness",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  modality_supported: {
    gate_class: "readiness",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  tool_support: {
    gate_class: "readiness",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  min_tokens_per_second: {
    gate_class: "performance",
    evaluation_phase: "pre_inference",
    blocking_default: false,
  },
  max_ttft_ms: {
    gate_class: "performance",
    evaluation_phase: "during_inference",
    blocking_default: false,
  },
  max_error_rate: {
    gate_class: "performance",
    evaluation_phase: "pre_inference",
    blocking_default: false,
  },
  min_free_memory_bytes: {
    gate_class: "performance",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  min_free_storage_bytes: {
    gate_class: "performance",
    evaluation_phase: "pre_inference",
    blocking_default: true,
  },
  benchmark_fresh: {
    gate_class: "performance",
    evaluation_phase: "pre_inference",
    blocking_default: false,
  },
  schema_valid: {
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    blocking_default: true,
  },
  tool_call_valid: {
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    blocking_default: true,
  },
  safety_passed: {
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    blocking_default: true,
  },
  evaluator_score_min: {
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    blocking_default: false,
  },
  json_parseable: {
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    blocking_default: true,
  },
  max_refusal_rate: {
    gate_class: "output_quality",
    evaluation_phase: "post_inference",
    blocking_default: false,
  },
};

/**
 * Look up the gate classification for a code. Returns undefined for unknown codes.
 */
export function classifyGate(
  code: string,
): GateClassification | undefined {
  return GATE_CLASSIFICATION[code];
}

// ---------------------------------------------------------------------------
// Interfaces — wire-format aligned with route_attempt.schema.json
// ---------------------------------------------------------------------------

/** Result of a single gate evaluation for an attempt. */
export interface GateResult {
  code: string;
  status: GateStatus;
  observed_number?: number;
  threshold_number?: number;
  reason_code?: string | null;
  gate_class?: GateClassValue;
  evaluation_phase?: EvaluationPhaseValue;
  observed_string?: string;
  safe_metadata?: Record<string, unknown>;
}

/** Artifact state at time of attempt. */
export interface AttemptArtifact {
  id: string | null;
  digest: string | null;
  cache: { status: string; managed_by: string | null };
}

/**
 * A single attempt in the per-request candidate evaluation loop.
 *
 * TODO(contracts): The `locality` and `mode` string unions should be replaced
 * by generated types (RouteLocality, RuntimeExecutionMode) from
 * octomil-contracts codegen. Currently matches the browser SDK's type aliases.
 */
export interface RouteAttempt {
  index: number;
  locality: "local" | "cloud";
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  engine: string | null;
  artifact: AttemptArtifact | null;
  status: AttemptStatus;
  stage: AttemptStage;
  gate_results: GateResult[];
  reason: { code: string; message: string };
}

/** Trigger that caused a fallback from one attempt to another. */
export interface FallbackTrigger {
  code: string;
  stage: string;
  message: string;
  gate_code?: string;
  gate_class?: GateClassValue;
  evaluation_phase?: EvaluationPhaseValue;
  candidate_index?: number;
  output_visible_before_failure?: boolean;
}

/** Result of running the full attempt loop. */
export interface AttemptLoopResult<T = unknown> {
  selectedAttempt: RouteAttempt | null;
  attempts: RouteAttempt[];
  fallbackUsed: boolean;
  fallbackTrigger: FallbackTrigger | null;
  fromAttempt: number | null;
  toAttempt: number | null;
  value?: T;
  error?: unknown;
  /** Advisory gate failures recorded but not blocking selection. */
  advisoryFailures?: Array<{
    code: string;
    gate_class: string;
    observed: number;
    threshold: number;
  }>;
}

// ---------------------------------------------------------------------------
// Pluggable checkers — injected by the caller
// ---------------------------------------------------------------------------

/** Checks whether a runtime engine is available for use. */
export interface RuntimeChecker {
  check(
    engine: string | null,
    locality: string,
  ): { available: boolean; reasonCode?: string };
}

/** Evaluates a single gate against a candidate. */
export interface GateEvaluator {
  evaluate(
    gate: CandidateGate,
    engine: string | null,
    locality: string,
  ): GateResult;
}

/**
 * Evaluates output quality gates after inference completes.
 *
 * Called with the inference output to validate schema conformance,
 * tool call validity, safety, etc.
 */
export interface OutputQualityGateEvaluator {
  evaluate(
    gate: CandidateGate,
    output: unknown,
  ): GateResult;
}

// ---------------------------------------------------------------------------
// Candidate plan — input from the runtime planner
// ---------------------------------------------------------------------------

/** A gate requirement attached to a candidate by the planner. */
export interface CandidateGate {
  code: string;
  required: boolean;
  threshold_number?: number;
  threshold_string?: string;
  window_seconds?: number;
  source: "server" | "sdk" | "runtime";
  gate_class?: GateClassValue;
  evaluation_phase?: EvaluationPhaseValue;
  fallback_eligible?: boolean;
  blocking_default?: boolean;
}

/** A single candidate from the runtime plan response. */
export interface CandidatePlan {
  locality: "local" | "cloud";
  engine?: string;
  artifact?: { artifact_id?: string; digest?: string };
  gates?: CandidateGate[];
  priority: number;
  confidence: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// No-op defaults — used when caller doesn't supply checkers
// ---------------------------------------------------------------------------

/**
 * Default RuntimeChecker: cloud is always available, local is never available.
 *
 * This is the correct server-side default. The Node SDK primarily routes to
 * hosted_gateway (cloud). Local availability requires an explicit checker.
 */
export class NoOpRuntimeChecker implements RuntimeChecker {
  check(
    _engine: string | null,
    locality: string,
  ): { available: boolean; reasonCode?: string } {
    if (locality === "cloud") {
      return { available: true };
    }
    return { available: false, reasonCode: "no_local_runtime_checker" };
  }
}

/**
 * Default GateEvaluator: required gates pass, optional gates return not_required.
 *
 * Used when no gate evaluator is provided. In production, the facade injects
 * a real evaluator that reads benchmark history, memory stats, etc.
 */
export class NoOpGateEvaluator implements GateEvaluator {
  evaluate(
    gate: CandidateGate,
    _engine: string | null,
    _locality: string,
  ): GateResult {
    const classification = classifyGate(gate.code);
    const base: GateResult = {
      code: gate.code,
      status: gate.required ? GateStatus.Unknown : GateStatus.NotRequired,
      gate_class: gate.gate_class ?? classification?.gate_class,
      evaluation_phase:
        gate.evaluation_phase ?? classification?.evaluation_phase,
    };
    if (!gate.required) {
      base.status = GateStatus.NotRequired;
    }
    return base;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for gate classification
// ---------------------------------------------------------------------------

/**
 * Resolve the effective gate class and evaluation phase for a gate.
 * Uses explicit values from the gate if present, otherwise falls back
 * to the GATE_CLASSIFICATION map.
 */
function resolveGateClassification(gate: CandidateGate): {
  gate_class: GateClassValue | undefined;
  evaluation_phase: EvaluationPhaseValue | undefined;
} {
  const classification = classifyGate(gate.code);
  return {
    gate_class: gate.gate_class ?? classification?.gate_class,
    evaluation_phase:
      gate.evaluation_phase ?? classification?.evaluation_phase,
  };
}

/**
 * Enrich a GateResult with gate_class and evaluation_phase from the gate
 * or the classification map.
 */
function enrichGateResult(
  result: GateResult,
  gate: CandidateGate,
): GateResult {
  const { gate_class, evaluation_phase } = resolveGateClassification(gate);
  return {
    ...result,
    gate_class: result.gate_class ?? gate_class,
    evaluation_phase: result.evaluation_phase ?? evaluation_phase,
  };
}

/**
 * Returns true if the gate is an output_quality gate that should be
 * evaluated post-inference rather than pre-inference.
 */
function isOutputQualityGate(gate: CandidateGate): boolean {
  const { evaluation_phase } = resolveGateClassification(gate);
  return evaluation_phase === "post_inference";
}

// ---------------------------------------------------------------------------
// CandidateAttemptRunner
// ---------------------------------------------------------------------------

/**
 * Runs the per-request candidate attempt loop.
 *
 * Iterates over candidates in priority order. For each candidate:
 * 1. Determine execution mode from locality
 * 2. Check runtime availability (prepare stage)
 * 3. Evaluate pre-inference gates (readiness + performance)
 * 4. If all required pre-inference gates pass -> status=selected, stage=inference
 * 5. If any required gate fails -> status=failed, record trigger, try next
 *
 * Output quality gates (post_inference phase) are skipped during the
 * pre-inference `run()` method. They are evaluated in `runWithInference()`
 * after the inference call completes.
 *
 * When fallbackAllowed=false (private/local_only policy), the loop stops
 * after the first failure without attempting subsequent candidates.
 */
export class CandidateAttemptRunner {
  private readonly fallbackAllowed: boolean;

  /**
   * Whether the request is streaming. Affects inference-time fallback
   * semantics: before the first token is emitted, fallback is allowed;
   * after the first token, it is not.
   */
  readonly streaming: boolean;

  private attempts: RouteAttempt[] = [];

  constructor(opts: { fallbackAllowed?: boolean; streaming?: boolean } = {}) {
    this.fallbackAllowed = opts.fallbackAllowed ?? true;
    this.streaming = opts.streaming ?? false;
  }

  /**
   * Whether a failed inference may move to the next candidate.
   *
   * Streaming requests may fall back only before any output has reached the
   * caller. After the first token/event, switching routes would splice two
   * independent model outputs into one stream.
   */
  shouldFallbackAfterInferenceError(firstOutputEmitted = false): boolean {
    return this.fallbackAllowed && !(this.streaming && firstOutputEmitted);
  }

  /**
   * Run the attempt loop over the given candidates.
   *
   * Output quality gates (post_inference) are skipped here since there is
   * no inference output to evaluate. Use `runWithInference()` for the full
   * gate lifecycle including post-inference quality checks.
   *
   * @param candidates - Ordered list of candidates from the runtime planner.
   * @param opts - Optional runtime checker and gate evaluator.
   * @returns Structured result with the selected attempt (if any), full
   *          attempt log, and fallback metadata.
   */
  run(
    candidates: CandidatePlan[],
    opts: {
      runtimeChecker?: RuntimeChecker;
      gateEvaluator?: GateEvaluator;
    } = {},
  ): AttemptLoopResult {
    const runtimeChecker = opts.runtimeChecker ?? new NoOpRuntimeChecker();
    const gateEvaluator = opts.gateEvaluator ?? new NoOpGateEvaluator();

    this.attempts = [];

    let selectedAttempt: RouteAttempt | null = null;
    let fallbackTrigger: FallbackTrigger | null = null;
    let fromAttempt: number | null = null;
    let toAttempt: number | null = null;

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const mode = resolveMode(candidate);
      const engine = candidate.engine ?? null;
      const artifact = candidate.artifact
        ? buildAttemptArtifact(candidate.artifact)
        : null;

      // ---------------------------------------------------------------
      // Stage: prepare — check runtime availability
      // ---------------------------------------------------------------

      const runtimeCheck = runtimeChecker.check(engine, candidate.locality);

      if (!runtimeCheck.available) {
        const gateResults: GateResult[] = [
          {
            code: "runtime_available",
            status: GateStatus.Failed,
            reason_code: runtimeCheck.reasonCode ?? "engine_not_installed",
            gate_class: "readiness",
            evaluation_phase: "pre_inference",
          },
        ];

        const failedAttempt: RouteAttempt = {
          index: i,
          locality: candidate.locality,
          mode,
          engine,
          artifact,
          status: AttemptStatus.Failed,
          stage: AttemptStage.Prepare,
          gate_results: gateResults,
          reason: {
            code: "runtime_unavailable",
            message: `${engine ?? candidate.locality} engine not available`,
          },
        };

        this.attempts.push(failedAttempt);

        // Record fallback trigger from the first failure
        if (fallbackTrigger === null) {
          fromAttempt = i;
          fallbackTrigger = {
            code: "runtime_unavailable",
            stage: AttemptStage.Prepare,
            message: failedAttempt.reason.message,
            gate_code: "runtime_available",
            gate_class: "readiness",
            evaluation_phase: "pre_inference",
            candidate_index: i,
            output_visible_before_failure: false,
          };
        }

        if (!this.fallbackAllowed) {
          break;
        }
        continue;
      }

      // ---------------------------------------------------------------
      // Stage: gate — evaluate pre-inference gates only
      // Output quality gates are deferred to post-inference evaluation.
      // ---------------------------------------------------------------

      const gates = candidate.gates ?? [];
      const gateResults: GateResult[] = [];

      // runtime_available already verified above — record as passed
      gateResults.push({
        code: "runtime_available",
        status: GateStatus.Passed,
        gate_class: "readiness",
        evaluation_phase: "pre_inference",
      });

      let gateFailure: GateResult | null = null;
      let failedGateCode: string | undefined;

      for (const gate of gates) {
        // Skip runtime_available — we already checked it
        if (gate.code === "runtime_available") {
          continue;
        }

        // Skip output_quality gates — they are evaluated post-inference
        if (isOutputQualityGate(gate)) {
          continue;
        }

        const result = enrichGateResult(
          gateEvaluator.evaluate(gate, engine, candidate.locality),
          gate,
        );
        gateResults.push(result);

        if (
          gate.required &&
          result.status === GateStatus.Failed &&
          gateFailure === null
        ) {
          gateFailure = result;
          failedGateCode = gate.code;
        }

        // Unknown required gate: fail closed
        if (
          gate.required &&
          result.status === GateStatus.Unknown &&
          !classifyGate(gate.code) &&
          gateFailure === null
        ) {
          gateFailure = {
            ...result,
            status: GateStatus.Failed,
            reason_code: "unknown_required_gate",
          };
          failedGateCode = gate.code;
        }
      }

      if (gateFailure !== null) {
        const failedAttempt: RouteAttempt = {
          index: i,
          locality: candidate.locality,
          mode,
          engine,
          artifact,
          status: AttemptStatus.Failed,
          stage: AttemptStage.Gate,
          gate_results: gateResults,
          reason: {
            code: "gate_failed",
            message: `${gateFailure.code} gate failed${gateFailure.observed_number != null && gateFailure.threshold_number != null ? `: observed ${gateFailure.observed_number} vs threshold ${gateFailure.threshold_number}` : ""}`,
          },
        };

        this.attempts.push(failedAttempt);

        // Record fallback trigger from the first failure
        if (fallbackTrigger === null) {
          fromAttempt = i;
          fallbackTrigger = {
            code: "gate_failed",
            stage: AttemptStage.Gate,
            message: failedAttempt.reason.message,
            gate_code: failedGateCode,
            gate_class: gateFailure.gate_class,
            evaluation_phase: gateFailure.evaluation_phase,
            candidate_index: i,
            output_visible_before_failure: false,
          };
        }

        if (!this.fallbackAllowed) {
          break;
        }
        continue;
      }

      // ---------------------------------------------------------------
      // All pre-inference gates passed — mark selected
      // ---------------------------------------------------------------

      const selected: RouteAttempt = {
        index: i,
        locality: candidate.locality,
        mode,
        engine,
        artifact,
        status: AttemptStatus.Selected,
        stage: AttemptStage.Inference,
        gate_results: gateResults,
        reason: {
          code: "selected",
          message:
            fallbackTrigger !== null
              ? `${candidate.locality} fallback after ${this.attempts[fromAttempt!]?.locality ?? "prior"} failure`
              : "all gates passed, inference succeeded",
        },
      };

      this.attempts.push(selected);
      selectedAttempt = selected;

      if (fallbackTrigger !== null) {
        toAttempt = i;
      }

      break;
    }

    const fallbackUsed = fallbackTrigger !== null && selectedAttempt !== null;

    return {
      selectedAttempt,
      attempts: this.attempts,
      fallbackUsed,
      fallbackTrigger: fallbackUsed ? fallbackTrigger : null,
      fromAttempt: fallbackUsed ? fromAttempt : null,
      toAttempt: fallbackUsed ? toAttempt : null,
    };
  }

  /**
   * Run readiness checks and execute inference for the selected candidate.
   *
   * This is the product-path API. After pre-inference gates pass, inference
   * is executed. Then output_quality gates are evaluated against the result.
   *
   * Post-inference gate failure before output is visible to the caller
   * triggers fallback to the next candidate. After the first token is
   * emitted (streaming), no fallback is possible.
   */
  async runWithInference<T>(
    candidates: CandidatePlan[],
    opts: {
      runtimeChecker?: RuntimeChecker;
      gateEvaluator?: GateEvaluator;
      outputQualityEvaluator?: OutputQualityGateEvaluator;
      executeCandidate: (
        candidate: CandidatePlan,
        attempt: RouteAttempt,
      ) => Promise<T> | T;
      firstOutputEmitted?: () => boolean;
    },
  ): Promise<AttemptLoopResult<T>> {
    const runtimeChecker = opts.runtimeChecker ?? new NoOpRuntimeChecker();
    const gateEvaluator = opts.gateEvaluator ?? new NoOpGateEvaluator();

    this.attempts = [];

    let fallbackTrigger: FallbackTrigger | null = null;
    let fromAttempt: number | null = null;
    let toAttempt: number | null = null;
    let lastError: unknown;
    const advisoryFailures: Array<{
      code: string;
      gate_class: string;
      observed: number;
      threshold: number;
    }> = [];

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const readinessRunner = new CandidateAttemptRunner({
        fallbackAllowed: false,
        streaming: this.streaming,
      });
      const readiness = readinessRunner.run([candidate], {
        runtimeChecker,
        gateEvaluator,
      });
      const attempt = readiness.attempts[0];

      if (!attempt || readiness.selectedAttempt === null) {
        if (attempt) {
          const failedAttempt = { ...attempt, index: i };
          this.attempts.push(failedAttempt);
          if (fallbackTrigger === null) {
            fallbackTrigger = {
              code: failedAttempt.reason.code,
              stage: failedAttempt.stage,
              message: failedAttempt.reason.message,
            };
            fromAttempt = i;
          }
        }

        if (!this.fallbackAllowed) {
          break;
        }
        continue;
      }

      const selectedAttempt = { ...readiness.selectedAttempt, index: i };

      try {
        const value = await opts.executeCandidate(candidate, selectedAttempt);

        // -----------------------------------------------------------
        // Post-inference: evaluate output_quality gates
        // -----------------------------------------------------------
        const outputQualityGates = (candidate.gates ?? []).filter(
          isOutputQualityGate,
        );

        if (outputQualityGates.length > 0) {
          let qualityFailure: {
            gate: CandidateGate;
            result: GateResult;
          } | null = null;

          for (const gate of outputQualityGates) {
            const result = enrichGateResult(
              opts.outputQualityEvaluator
                ? opts.outputQualityEvaluator.evaluate(gate, value)
                : {
                    code: gate.code,
                    status: gate.required
                      ? GateStatus.Failed
                      : GateStatus.Unknown,
                    reason_code: "no_evaluator",
                  },
              gate,
            );
            selectedAttempt.gate_results.push(result);

            if (result.status === GateStatus.Failed) {
              if (gate.required) {
                if (qualityFailure === null) {
                  qualityFailure = { gate, result };
                }
              } else {
                // Advisory failure — record but don't block
                advisoryFailures.push({
                  code: gate.code,
                  gate_class:
                    result.gate_class ?? "output_quality",
                  observed: result.observed_number ?? 0,
                  threshold: result.threshold_number ?? 0,
                });
              }
            }
          }

          if (qualityFailure !== null) {
            const { gate, result } = qualityFailure;
            const outputVisible =
              opts.firstOutputEmitted?.() ?? false;

            // Record as failed attempt at output_quality stage
            const failedAttempt: RouteAttempt = {
              ...selectedAttempt,
              status: AttemptStatus.Failed,
              stage: AttemptStage.OutputQuality,
              reason: {
                code: "gate_failed",
                message: outputVisible
                  ? `${gate.code} gate failed after first token; output already visible`
                  : `${gate.code} gate failed`,
              },
            };
            this.attempts.push(failedAttempt);

            const trigger: FallbackTrigger = {
              code: "gate_failed",
              stage: AttemptStage.OutputQuality,
              message: failedAttempt.reason.message,
              gate_code: gate.code,
              gate_class: result.gate_class ?? "output_quality",
              evaluation_phase:
                result.evaluation_phase ?? "post_inference",
              candidate_index: i,
              output_visible_before_failure: outputVisible,
            };

            if (outputVisible) {
              // Output already visible — cannot fallback, record
              // the trigger but don't use fallback
              return {
                selectedAttempt: null,
                attempts: this.attempts,
                fallbackUsed: false,
                fallbackTrigger: trigger,
                fromAttempt: null,
                toAttempt: null,
                error: new Error(failedAttempt.reason.message),
                advisoryFailures:
                  advisoryFailures.length > 0
                    ? advisoryFailures
                    : undefined,
              };
            }

            // Output not visible — can try fallback
            if (fallbackTrigger === null) {
              fallbackTrigger = trigger;
              fromAttempt = i;
            }

            if (this.fallbackAllowed && i < candidates.length - 1) {
              continue;
            }

            // No fallback possible (disabled or last candidate)
            return {
              selectedAttempt: null,
              attempts: this.attempts,
              fallbackUsed: false,
              fallbackTrigger: trigger,
              fromAttempt: null,
              toAttempt: null,
              error: new Error(failedAttempt.reason.message),
              advisoryFailures:
                advisoryFailures.length > 0
                  ? advisoryFailures
                  : undefined,
            };
          }
        }

        // All gates (including output quality) passed
        this.attempts.push(selectedAttempt);
        if (fallbackTrigger !== null) {
          toAttempt = i;
        }
        const fallbackUsed = fallbackTrigger !== null;
        return {
          selectedAttempt,
          attempts: this.attempts,
          fallbackUsed,
          fallbackTrigger: fallbackUsed ? fallbackTrigger : null,
          fromAttempt: fallbackUsed ? fromAttempt : null,
          toAttempt: fallbackUsed ? toAttempt : null,
          value,
          advisoryFailures:
            advisoryFailures.length > 0 ? advisoryFailures : undefined,
        };
      } catch (error) {
        lastError = error;
        const firstOutputEmitted = opts.firstOutputEmitted?.() ?? false;
        const reasonCode =
          this.streaming && firstOutputEmitted
            ? "inference_error_after_first_output"
            : this.streaming
              ? "inference_error_before_first_output"
              : "inference_error";
        const failedAttempt: RouteAttempt = {
          ...selectedAttempt,
          status: AttemptStatus.Failed,
          stage: AttemptStage.Inference,
          reason: {
            code: reasonCode,
            message: errorMessage(error),
          },
        };
        this.attempts.push(failedAttempt);

        if (fallbackTrigger === null) {
          fallbackTrigger = {
            code: reasonCode,
            stage: AttemptStage.Inference,
            message: failedAttempt.reason.message,
          };
          fromAttempt = i;
        }

        if (
          i >= candidates.length - 1 ||
          !this.shouldFallbackAfterInferenceError(firstOutputEmitted)
        ) {
          break;
        }
      }
    }

    return {
      selectedAttempt: null,
      attempts: this.attempts,
      fallbackUsed: false,
      fallbackTrigger: null,
      fromAttempt: null,
      toAttempt: null,
      error: lastError,
    };
  }

  /**
   * Produce the route_metadata.fallback and route_metadata.attempts fields
   * suitable for embedding in a RouteMetadata response object.
   */
  toRouteMetadataFields(): {
    attempts: RouteAttempt[];
    fallback: {
      used: boolean;
      from_attempt: number | null;
      to_attempt: number | null;
      trigger: FallbackTrigger | null;
    };
  } {
    const result = this.getLastResult();
    return {
      attempts: result.attempts,
      fallback: {
        used: result.fallbackUsed,
        from_attempt: result.fromAttempt,
        to_attempt: result.toAttempt,
        trigger: result.fallbackTrigger,
      },
    };
  }

  /** Return the current attempts array (useful for inspection after `run`). */
  getAttempts(): readonly RouteAttempt[] {
    return this.attempts;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getLastResult(): AttemptLoopResult {
    const selectedAttempt =
      this.attempts.find((a) => a.status === AttemptStatus.Selected) ?? null;

    // Find the first failure (fallback trigger) if a selected attempt exists
    // after it.
    let fallbackTrigger: FallbackTrigger | null = null;
    let fromAttempt: number | null = null;
    let toAttempt: number | null = null;

    if (selectedAttempt !== null) {
      const firstFailure = this.attempts.find(
        (a) => a.status === AttemptStatus.Failed,
      );
      if (firstFailure && firstFailure.index < selectedAttempt.index) {
        fromAttempt = firstFailure.index;
        toAttempt = selectedAttempt.index;
        fallbackTrigger = {
          code: firstFailure.reason.code,
          stage: firstFailure.stage,
          message: firstFailure.reason.message,
        };
      }
    }

    const fallbackUsed = fallbackTrigger !== null;

    return {
      selectedAttempt,
      attempts: this.attempts,
      fallbackUsed,
      fallbackTrigger: fallbackUsed ? fallbackTrigger : null,
      fromAttempt: fallbackUsed ? fromAttempt : null,
      toAttempt: fallbackUsed ? toAttempt : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the execution mode for a candidate based on its locality.
 *
 * - cloud -> hosted_gateway
 * - local -> sdk_runtime
 *
 * The caller can override to external_endpoint when a user-configured local
 * serve endpoint is detected.
 */
function resolveMode(
  candidate: CandidatePlan,
): "sdk_runtime" | "hosted_gateway" | "external_endpoint" {
  return candidate.locality === "cloud" ? "hosted_gateway" : "sdk_runtime";
}

/** Build an AttemptArtifact from the candidate's artifact info. */
function buildAttemptArtifact(artifact: {
  artifact_id?: string;
  digest?: string;
}): AttemptArtifact {
  return {
    id: artifact.artifact_id ?? null,
    digest: artifact.digest ?? null,
    cache: { status: "not_applicable", managed_by: null },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
