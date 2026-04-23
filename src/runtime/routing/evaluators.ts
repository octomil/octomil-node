/**
 * Built-in output quality gate evaluators.
 *
 * Each evaluator implements the `OutputQualityEvaluator` interface and
 * returns an `EvaluatorResult`. Evaluators run **in the SDK process** ---
 * prompt/output content never leaves the caller's machine.
 *
 * Built-in evaluators:
 *
 * - `JsonParseableEvaluator`   --- checks that output parses as JSON.
 * - `JsonSchemaEvaluator`      --- validates output against a JSON Schema.
 * - `ToolCallValidEvaluator`   --- validates tool-call structure.
 * - `RegexPredicateEvaluator`  --- matches output against a regex pattern.
 * - `SafetyPassedEvaluator`    --- adapter stub for app-provided safety check.
 */

import { GateStatus } from "./attempt-runner.js";
import type { CandidateGate, GateResult } from "./attempt-runner.js";

// ---------------------------------------------------------------------------
// EvaluatorResult
// ---------------------------------------------------------------------------

/**
 * Privacy-safe result from an output quality evaluator.
 *
 * `safe_metadata` is sanitized by the forbidden-key filter before
 * inclusion in telemetry --- no prompt, output, or content fields may
 * survive.
 */
export interface EvaluatorResult {
  passed: boolean;
  score?: number;
  reason_code?: string;
  safe_metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OutputQualityEvaluator interface
// ---------------------------------------------------------------------------

/**
 * Interface for post-inference output quality evaluation.
 *
 * Implementations receive the gate definition and the inference response.
 * They MUST NOT upload or log prompt/output content.
 */
export interface OutputQualityEvaluator {
  name: string;
  evaluate(input: {
    gate: Record<string, unknown>;
    response: unknown;
  }): EvaluatorResult;
}

// ---------------------------------------------------------------------------
// Helper: extract text from response
// ---------------------------------------------------------------------------

/**
 * Extract text content from a response object.
 *
 * Supports: string, dict with "text"/"content"/"output" key, objects with
 * .text/.content/.output attributes.
 */
export function extractText(response: unknown): string | undefined {
  if (typeof response === "string") {
    return response;
  }
  if (response !== null && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    for (const key of ["text", "content", "output"]) {
      if (key in obj && typeof obj[key] === "string") {
        return obj[key] as string;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper: extract tool calls from response
// ---------------------------------------------------------------------------

/**
 * Extract tool calls from a response object.
 *
 * Supports: dict with "tool_calls" key, objects with .tool_calls attribute.
 * Returns undefined if no tool calls are present.
 */
export function extractToolCalls(
  response: unknown,
): Array<Record<string, unknown>> | undefined {
  if (response !== null && typeof response === "object") {
    const obj = response as Record<string, unknown>;
    const tc = obj["tool_calls"];
    if (Array.isArray(tc) && tc.length > 0) {
      return tc as Array<Record<string, unknown>>;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JsonParseableEvaluator
// ---------------------------------------------------------------------------

/**
 * Checks that the response text is valid JSON.
 *
 * Maps to gate code `json_parseable`.
 */
export class JsonParseableEvaluator implements OutputQualityEvaluator {
  readonly name = "json_parseable";

  evaluate(input: {
    gate: Record<string, unknown>;
    response: unknown;
  }): EvaluatorResult {
    const text = extractText(input.response);
    if (text === undefined) {
      return {
        passed: false,
        reason_code: "no_text_content",
        safe_metadata: { evaluator_name: this.name },
      };
    }
    try {
      JSON.parse(text);
      return {
        passed: true,
        safe_metadata: { evaluator_name: this.name },
      };
    } catch (exc) {
      return {
        passed: false,
        reason_code: "json_parse_error",
        safe_metadata: {
          evaluator_name: this.name,
          error_type:
            exc instanceof Error ? exc.constructor.name : "UnknownError",
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// JsonSchemaEvaluator
// ---------------------------------------------------------------------------

/**
 * Validates the response text against a JSON Schema.
 *
 * The schema is taken from `gate.config.schema` (a dict) or
 * provided at construction time.
 *
 * Uses Ajv for validation if available; gracefully degrades if not installed.
 *
 * Maps to gate code `schema_valid`.
 */
export class JsonSchemaEvaluator implements OutputQualityEvaluator {
  readonly name = "json_schema";

  private readonly defaultSchema: Record<string, unknown> | undefined;

  constructor(opts?: { defaultSchema?: Record<string, unknown> }) {
    this.defaultSchema = opts?.defaultSchema;
  }

  evaluate(input: {
    gate: Record<string, unknown>;
    response: unknown;
  }): EvaluatorResult {
    const text = extractText(input.response);
    if (text === undefined) {
      return {
        passed: false,
        reason_code: "no_text_content",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    const config = input.gate["config"] as Record<string, unknown> | undefined;
    const schema =
      (config?.["schema"] as Record<string, unknown> | undefined) ??
      this.defaultSchema;
    if (schema === undefined) {
      return {
        passed: false,
        reason_code: "no_schema_configured",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        passed: false,
        reason_code: "json_parse_error",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    // Attempt to load Ajv for JSON Schema validation
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Ajv = requireAjv();
      if (Ajv === undefined) {
        return {
          passed: false,
          reason_code: "ajv_not_installed",
          safe_metadata: { evaluator_name: this.name },
        };
      }
      const ajv = new Ajv({ allErrors: true });
      const validate = ajv.compile(schema);
      const valid = validate(data);
      if (valid) {
        return {
          passed: true,
          safe_metadata: { evaluator_name: this.name },
        };
      }
      const firstError = validate.errors?.[0];
      return {
        passed: false,
        reason_code: "schema_validation_error",
        safe_metadata: {
          evaluator_name: this.name,
          validation_path: firstError?.instancePath ?? "",
        },
      };
    } catch {
      return {
        passed: false,
        reason_code: "ajv_not_installed",
        safe_metadata: { evaluator_name: this.name },
      };
    }
  }
}

/**
 * Attempt to require Ajv. Returns the Ajv constructor or undefined if
 * not installed. Graceful degradation --- never throws.
 */
function requireAjv(): (new (opts?: Record<string, unknown>) => AjvInstance) | undefined {
  try {
    // Dynamic import fallback for optional dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("ajv") as { default?: new (opts?: Record<string, unknown>) => AjvInstance } | (new (opts?: Record<string, unknown>) => AjvInstance);
    // Ajv can be exported as default or directly
    if (typeof mod === "function") {
      return mod;
    }
    if (mod && typeof mod.default === "function") {
      return mod.default;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Minimal Ajv instance interface for type safety. */
interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidateFunction;
}

interface AjvValidateFunction {
  (data: unknown): boolean;
  errors?: Array<{ instancePath: string; message?: string }> | null;
}

// ---------------------------------------------------------------------------
// ToolCallValidEvaluator
// ---------------------------------------------------------------------------

/**
 * Validates that tool calls in the response have the required structure.
 *
 * Checks that each tool call has `name` and `arguments` fields and
 * that `arguments` is valid JSON (if it is a string).
 *
 * Maps to gate code `tool_call_valid`.
 */
export class ToolCallValidEvaluator implements OutputQualityEvaluator {
  readonly name = "tool_call_valid";

  evaluate(input: {
    gate: Record<string, unknown>;
    response: unknown;
  }): EvaluatorResult {
    const toolCalls = extractToolCalls(input.response);
    if (toolCalls === undefined) {
      // No tool calls in response --- pass (gate only applies when tools present)
      return {
        passed: true,
        safe_metadata: { evaluator_name: this.name, tool_call_count: "0" },
      };
    }

    const errors: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!;
      if (typeof tc !== "object" || tc === null || Array.isArray(tc)) {
        errors.push(`tool_call[${i}]:not_dict`);
        continue;
      }
      if (!("name" in tc)) {
        errors.push(`tool_call[${i}]:missing_name`);
      }
      const args = tc["arguments"];
      if (args !== undefined && typeof args === "string") {
        try {
          JSON.parse(args);
        } catch {
          errors.push(`tool_call[${i}]:invalid_arguments_json`);
        }
      }
    }

    if (errors.length > 0) {
      return {
        passed: false,
        reason_code: "tool_call_validation_error",
        safe_metadata: {
          evaluator_name: this.name,
          error_count: String(errors.length),
          first_error: errors[0],
        },
      };
    }
    return {
      passed: true,
      safe_metadata: {
        evaluator_name: this.name,
        tool_call_count: String(toolCalls.length),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// RegexPredicateEvaluator
// ---------------------------------------------------------------------------

/**
 * Matches the response text against a regex pattern.
 *
 * The pattern is taken from `gate.config.pattern` (a string) or
 * provided at construction time. A match anywhere in the text passes.
 *
 * Maps to gate code `evaluator_score_min` or custom codes.
 */
export class RegexPredicateEvaluator implements OutputQualityEvaluator {
  readonly name = "regex_predicate";

  private readonly defaultPattern: string | undefined;

  constructor(opts?: { defaultPattern?: string }) {
    this.defaultPattern = opts?.defaultPattern;
  }

  evaluate(input: {
    gate: Record<string, unknown>;
    response: unknown;
  }): EvaluatorResult {
    const text = extractText(input.response);
    if (text === undefined) {
      return {
        passed: false,
        reason_code: "no_text_content",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    const config = input.gate["config"] as Record<string, unknown> | undefined;
    const pattern =
      (config?.["pattern"] as string | undefined) ?? this.defaultPattern;
    if (pattern === undefined) {
      return {
        passed: false,
        reason_code: "no_pattern_configured",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    let match: RegExpMatchArray | null;
    try {
      match = new RegExp(pattern).exec(text);
    } catch {
      return {
        passed: false,
        reason_code: "invalid_regex_pattern",
        safe_metadata: { evaluator_name: this.name },
      };
    }

    return {
      passed: match !== null,
      score: match !== null ? 1.0 : 0.0,
      reason_code: match !== null ? undefined : "pattern_not_matched",
      safe_metadata: { evaluator_name: this.name },
    };
  }
}

// ---------------------------------------------------------------------------
// SafetyPassedEvaluator (adapter stub)
// ---------------------------------------------------------------------------

/**
 * Adapter stub for app-provided safety evaluation.
 *
 * This evaluator does NOT implement a classifier itself. It delegates to
 * an app-provided `check` callback. If no callback is provided, it fails
 * closed so required `safety_passed` gates cannot accidentally pass.
 *
 * Maps to gate code `safety_passed`.
 */
export class SafetyPassedEvaluator implements OutputQualityEvaluator {
  readonly name = "safety_passed";

  private readonly check:
    | ((response: unknown) => boolean | EvaluatorResult)
    | undefined;

  constructor(opts?: {
    check?: (response: unknown) => boolean | EvaluatorResult;
  }) {
    this.check = opts?.check;
  }

  evaluate(input: {
    gate: Record<string, unknown>;
    response: unknown;
  }): EvaluatorResult {
    if (this.check === undefined) {
      return {
        passed: false,
        reason_code: "no_safety_checker_configured",
        safe_metadata: { evaluator_name: this.name },
      };
    }
    try {
      const result = this.check(input.response);
      if (typeof result === "boolean") {
        return {
          passed: result,
          reason_code: result ? undefined : "safety_check_failed",
          safe_metadata: { evaluator_name: this.name },
        };
      }
      // Assume result is an EvaluatorResult-like object
      return {
        passed: Boolean(result.passed),
        score: result.score,
        reason_code: result.reason_code,
        safe_metadata:
          result.safe_metadata ?? { evaluator_name: this.name },
      };
    } catch {
      return {
        passed: false,
        reason_code: "safety_checker_error",
        safe_metadata: { evaluator_name: this.name },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// EvaluatorRegistry
// ---------------------------------------------------------------------------

/**
 * Maps gate codes to evaluator instances.
 *
 * Default built-in evaluators are registered automatically. Apps can
 * override or extend by passing custom evaluators.
 */
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, OutputQualityEvaluator>();

  /** Register an evaluator for a gate code. */
  register(gateCode: string, evaluator: OutputQualityEvaluator): void {
    this.evaluators.set(gateCode, evaluator);
  }

  /** Get the evaluator for a gate code, or undefined. */
  get(gateCode: string): OutputQualityEvaluator | undefined {
    return this.evaluators.get(gateCode);
  }

  /**
   * Create a registry with built-in evaluators pre-registered.
   *
   * @param opts.jsonSchema - Default JSON Schema for schema_valid gate.
   * @param opts.safetyCheck - Callback for safety_passed gate.
   * @param opts.extra - Additional evaluators to register.
   */
  static withDefaults(opts?: {
    jsonSchema?: Record<string, unknown>;
    safetyCheck?: (response: unknown) => boolean | EvaluatorResult;
    extra?: Record<string, OutputQualityEvaluator>;
  }): EvaluatorRegistry {
    const reg = new EvaluatorRegistry();
    reg.register("json_parseable", new JsonParseableEvaluator());
    reg.register(
      "schema_valid",
      new JsonSchemaEvaluator({ defaultSchema: opts?.jsonSchema }),
    );
    reg.register("tool_call_valid", new ToolCallValidEvaluator());
    if (opts?.safetyCheck !== undefined) {
      reg.register(
        "safety_passed",
        new SafetyPassedEvaluator({ check: opts.safetyCheck }),
      );
    }
    if (opts?.extra) {
      for (const [code, evaluator] of Object.entries(opts.extra)) {
        reg.register(code, evaluator);
      }
    }
    return reg;
  }
}

// ---------------------------------------------------------------------------
// RegistryBackedEvaluator
// ---------------------------------------------------------------------------

/**
 * Bridges the per-gate evaluator registry into the single-evaluator
 * interface expected by `CandidateAttemptRunner`.
 *
 * Implements a `evaluate(gate, output)` method returning a `GateResult`
 * that the attempt runner can consume directly.
 */
export class RegistryBackedEvaluator {
  readonly name = "registry";

  private readonly registry: EvaluatorRegistry;

  constructor(registry: EvaluatorRegistry) {
    this.registry = registry;
  }

  /**
   * Evaluate a gate using the registered evaluator.
   *
   * Returns a GateResult for the attempt runner.
   */
  evaluate(gate: CandidateGate, output: unknown): GateResult {
    const code = gate.code ?? "";
    const evaluator = this.registry.get(code);
    if (evaluator === undefined) {
      return {
        code,
        status: GateStatus.Failed,
        reason_code: "evaluator_missing",
      };
    }
    const gateRecord = gate as unknown as Record<string, unknown>;
    const result = evaluator.evaluate({ gate: gateRecord, response: output });
    return {
      code,
      status: result.passed ? GateStatus.Passed : GateStatus.Failed,
      observed_number: result.score,
      reason_code: result.reason_code,
      safe_metadata: result.safe_metadata,
    };
  }
}
