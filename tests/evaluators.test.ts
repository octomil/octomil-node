import { describe, it, expect } from "vitest";
import {
  JsonParseableEvaluator,
  JsonSchemaEvaluator,
  ToolCallValidEvaluator,
  RegexPredicateEvaluator,
  SafetyPassedEvaluator,
  EvaluatorRegistry,
  RegistryBackedEvaluator,
  extractText,
  extractToolCalls,
} from "../src/runtime/routing/evaluators.js";
import type {
  EvaluatorResult,
  OutputQualityEvaluator,
} from "../src/runtime/routing/evaluators.js";
import { GateStatus } from "../src/runtime/routing/attempt-runner.js";

// ---------------------------------------------------------------------------
// extractText helper
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("extracts from string", () => {
    expect(extractText("hello")).toBe("hello");
  });

  it("extracts from dict with text key", () => {
    expect(extractText({ text: "hello" })).toBe("hello");
  });

  it("extracts from dict with content key", () => {
    expect(extractText({ content: "hello" })).toBe("hello");
  });

  it("extracts from dict with output key", () => {
    expect(extractText({ output: "hello" })).toBe("hello");
  });

  it("prefers text over content over output", () => {
    expect(extractText({ text: "a", content: "b", output: "c" })).toBe("a");
    expect(extractText({ content: "b", output: "c" })).toBe("b");
  });

  it("returns undefined for null", () => {
    expect(extractText(null)).toBeUndefined();
  });

  it("returns undefined for number", () => {
    expect(extractText(42)).toBeUndefined();
  });

  it("returns undefined for dict without text keys", () => {
    expect(extractText({ some_other_key: 123 })).toBeUndefined();
  });

  it("returns undefined for dict with non-string text", () => {
    expect(extractText({ text: 42 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractToolCalls helper
// ---------------------------------------------------------------------------

describe("extractToolCalls", () => {
  it("extracts from dict with tool_calls key", () => {
    const calls = [{ name: "fn", arguments: "{}" }];
    expect(extractToolCalls({ tool_calls: calls })).toEqual(calls);
  });

  it("returns undefined for empty tool_calls array", () => {
    expect(extractToolCalls({ tool_calls: [] })).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(extractToolCalls(null)).toBeUndefined();
  });

  it("returns undefined for string", () => {
    expect(extractToolCalls("hello")).toBeUndefined();
  });

  it("returns undefined for dict without tool_calls", () => {
    expect(extractToolCalls({ text: "hello" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JsonParseableEvaluator
// ---------------------------------------------------------------------------

describe("JsonParseableEvaluator", () => {
  const ev = new JsonParseableEvaluator();

  it("passes for valid JSON object", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: '{"key": "value"}',
    });
    expect(result.passed).toBe(true);
  });

  it("passes for valid JSON array", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: "[1, 2, 3]",
    });
    expect(result.passed).toBe(true);
  });

  it("fails for invalid JSON", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: "not json at all",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("json_parse_error");
  });

  it("fails for empty string", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: "",
    });
    expect(result.passed).toBe(false);
  });

  it("works with dict response with text key", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: { text: '{"valid": true}' },
    });
    expect(result.passed).toBe(true);
  });

  it("works with dict response with content key", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: { content: '{"valid": true}' },
    });
    expect(result.passed).toBe(true);
  });

  it("fails for no text content", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: { some_other_key: 123 },
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });

  it("fails for null response", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: null,
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });

  it("includes safe_metadata with evaluator_name", () => {
    const result = ev.evaluate({
      gate: { code: "json_parseable" },
      response: '{"a": 1}',
    });
    expect(result.safe_metadata).toBeDefined();
    expect(result.safe_metadata?.["evaluator_name"]).toBe("json_parseable");
  });
});

// ---------------------------------------------------------------------------
// JsonSchemaEvaluator
// ---------------------------------------------------------------------------

describe("JsonSchemaEvaluator", () => {
  const simpleSchema = {
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name"],
  };

  it("passes for valid data against default schema", () => {
    const ev = new JsonSchemaEvaluator({ defaultSchema: simpleSchema });
    const result = ev.evaluate({
      gate: { code: "schema_valid" },
      response: JSON.stringify({ name: "Alice", age: 30 }),
    });
    // Passes if Ajv is installed, otherwise fails gracefully
    if (result.reason_code === "ajv_not_installed") {
      expect(result.passed).toBe(false);
    } else {
      expect(result.passed).toBe(true);
    }
  });

  it("fails for invalid data against default schema", () => {
    const ev = new JsonSchemaEvaluator({ defaultSchema: simpleSchema });
    const result = ev.evaluate({
      gate: { code: "schema_valid" },
      response: JSON.stringify({ age: 30 }), // missing required "name"
    });
    // Fails if Ajv is installed (schema_validation_error), otherwise ajv_not_installed
    expect(result.passed).toBe(false);
    expect(["schema_validation_error", "ajv_not_installed"]).toContain(
      result.reason_code,
    );
  });

  it("uses schema from gate config", () => {
    const ev = new JsonSchemaEvaluator();
    const gate = {
      code: "schema_valid",
      config: { schema: { type: "array", items: { type: "number" } } },
    };
    const result = ev.evaluate({ gate, response: "[1, 2, 3]" });
    if (result.reason_code === "ajv_not_installed") {
      expect(result.passed).toBe(false);
    } else {
      expect(result.passed).toBe(true);
    }
  });

  it("fails when no schema is configured", () => {
    const ev = new JsonSchemaEvaluator();
    const result = ev.evaluate({
      gate: { code: "schema_valid" },
      response: '{"a": 1}',
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_schema_configured");
  });

  it("fails for invalid JSON input", () => {
    const ev = new JsonSchemaEvaluator({ defaultSchema: simpleSchema });
    const result = ev.evaluate({
      gate: { code: "schema_valid" },
      response: "not json",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("json_parse_error");
  });

  it("fails for no text content", () => {
    const ev = new JsonSchemaEvaluator({ defaultSchema: simpleSchema });
    const result = ev.evaluate({
      gate: { code: "schema_valid" },
      response: null,
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });
});

// ---------------------------------------------------------------------------
// ToolCallValidEvaluator
// ---------------------------------------------------------------------------

describe("ToolCallValidEvaluator", () => {
  const ev = new ToolCallValidEvaluator();

  it("passes when no tool calls present", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: { text: "just text, no tools" },
    });
    expect(result.passed).toBe(true);
  });

  it("passes for valid tool calls", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: {
        tool_calls: [
          { name: "get_weather", arguments: '{"city": "NYC"}' },
          { name: "search", arguments: '{"q": "test"}' },
        ],
      },
    });
    expect(result.passed).toBe(true);
  });

  it("fails when tool call is missing name", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: { tool_calls: [{ arguments: "{}" }] },
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("tool_call_validation_error");
  });

  it("fails when tool call has invalid arguments JSON", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: {
        tool_calls: [{ name: "fn", arguments: "not json" }],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("tool_call_validation_error");
  });

  it("passes when arguments is a dict (not string)", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: {
        tool_calls: [{ name: "fn", arguments: { k: "v" } }],
      },
    });
    expect(result.passed).toBe(true);
  });

  it("fails when tool call is not a dict", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: { tool_calls: ["not_a_dict"] },
    });
    expect(result.passed).toBe(false);
  });

  it("includes tool_call_count in safe_metadata for valid calls", () => {
    const result = ev.evaluate({
      gate: { code: "tool_call_valid" },
      response: {
        tool_calls: [
          { name: "fn1", arguments: "{}" },
          { name: "fn2", arguments: "{}" },
        ],
      },
    });
    expect(result.safe_metadata?.["tool_call_count"]).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// RegexPredicateEvaluator
// ---------------------------------------------------------------------------

describe("RegexPredicateEvaluator", () => {
  it("passes when match is found", () => {
    const ev = new RegexPredicateEvaluator({
      defaultPattern: "\\d{3}-\\d{4}",
    });
    const result = ev.evaluate({
      gate: { code: "evaluator_score_min" },
      response: "Call 555-1234",
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1.0);
  });

  it("fails when no match is found", () => {
    const ev = new RegexPredicateEvaluator({
      defaultPattern: "\\d{3}-\\d{4}",
    });
    const result = ev.evaluate({
      gate: { code: "evaluator_score_min" },
      response: "no numbers here",
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.0);
    expect(result.reason_code).toBe("pattern_not_matched");
  });

  it("uses pattern from gate config", () => {
    const ev = new RegexPredicateEvaluator();
    const gate = {
      code: "evaluator_score_min",
      config: { pattern: "^OK$" },
    };
    const result = ev.evaluate({ gate, response: "OK" });
    expect(result.passed).toBe(true);
  });

  it("fails when no pattern is configured", () => {
    const ev = new RegexPredicateEvaluator();
    const result = ev.evaluate({
      gate: { code: "evaluator_score_min" },
      response: "anything",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_pattern_configured");
  });

  it("fails for invalid regex pattern", () => {
    const ev = new RegexPredicateEvaluator({ defaultPattern: "[invalid" });
    const result = ev.evaluate({
      gate: { code: "evaluator_score_min" },
      response: "test",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("invalid_regex_pattern");
  });

  it("fails for no text content", () => {
    const ev = new RegexPredicateEvaluator({ defaultPattern: "test" });
    const result = ev.evaluate({
      gate: { code: "evaluator_score_min" },
      response: null,
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_text_content");
  });
});

// ---------------------------------------------------------------------------
// SafetyPassedEvaluator
// ---------------------------------------------------------------------------

describe("SafetyPassedEvaluator", () => {
  it("fails closed when no checker is configured", () => {
    const ev = new SafetyPassedEvaluator();
    const result = ev.evaluate({
      gate: { code: "safety_passed" },
      response: "anything",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("no_safety_checker_configured");
  });

  it("passes when checker returns true", () => {
    const ev = new SafetyPassedEvaluator({ check: () => true });
    const result = ev.evaluate({
      gate: { code: "safety_passed" },
      response: "safe content",
    });
    expect(result.passed).toBe(true);
  });

  it("fails when checker returns false", () => {
    const ev = new SafetyPassedEvaluator({ check: () => false });
    const result = ev.evaluate({
      gate: { code: "safety_passed" },
      response: "unsafe content",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("safety_check_failed");
  });

  it("fails when checker throws", () => {
    const ev = new SafetyPassedEvaluator({
      check: () => {
        throw new Error("checker broke");
      },
    });
    const result = ev.evaluate({
      gate: { code: "safety_passed" },
      response: "anything",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("safety_checker_error");
  });

  it("handles checker returning EvaluatorResult-like object", () => {
    const ev = new SafetyPassedEvaluator({
      check: (): EvaluatorResult => ({
        passed: false,
        score: 0.2,
        reason_code: "toxic_content",
        safe_metadata: { evaluator_name: "my_safety" },
      }),
    });
    const result = ev.evaluate({
      gate: { code: "safety_passed" },
      response: "test",
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0.2);
    expect(result.reason_code).toBe("toxic_content");
  });
});

// ---------------------------------------------------------------------------
// EvaluatorRegistry
// ---------------------------------------------------------------------------

describe("EvaluatorRegistry", () => {
  it("registers and retrieves evaluators", () => {
    const reg = new EvaluatorRegistry();
    const ev = new JsonParseableEvaluator();
    reg.register("json_parseable", ev);
    expect(reg.get("json_parseable")).toBe(ev);
  });

  it("returns undefined for unknown gate code", () => {
    const reg = new EvaluatorRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("withDefaults registers safe built-in evaluators", () => {
    const reg = EvaluatorRegistry.withDefaults();
    expect(reg.get("json_parseable")).toBeDefined();
    expect(reg.get("schema_valid")).toBeDefined();
    expect(reg.get("tool_call_valid")).toBeDefined();
    expect(reg.get("safety_passed")).toBeUndefined();
  });

  it("withDefaults registers safety evaluator only when a checker is provided", () => {
    const reg = EvaluatorRegistry.withDefaults({ safetyCheck: () => true });
    expect(reg.get("safety_passed")).toBeDefined();
  });

  it("withDefaults accepts extra evaluators", () => {
    const custom = new RegexPredicateEvaluator({ defaultPattern: "test" });
    const reg = EvaluatorRegistry.withDefaults({
      extra: { custom_gate: custom },
    });
    expect(reg.get("custom_gate")).toBe(custom);
    expect(reg.get("json_parseable")).toBeDefined();
  });

  it("withDefaults passes jsonSchema to JsonSchemaEvaluator", () => {
    const schema = { type: "object" };
    const reg = EvaluatorRegistry.withDefaults({ jsonSchema: schema });
    const ev = reg.get("schema_valid");
    expect(ev).toBeDefined();
    // Verify the evaluator actually uses the schema by testing it
    const result = ev!.evaluate({
      gate: { code: "schema_valid" },
      response: "{}",
    });
    // If Ajv is installed, should pass; if not, ajv_not_installed
    if (result.reason_code !== "ajv_not_installed") {
      expect(result.passed).toBe(true);
    }
  });

  it("withDefaults passes safetyCheck to SafetyPassedEvaluator", () => {
    const reg = EvaluatorRegistry.withDefaults({
      safetyCheck: () => false,
    });
    const ev = reg.get("safety_passed");
    expect(ev).toBeDefined();
    const result = ev!.evaluate({
      gate: { code: "safety_passed" },
      response: "test",
    });
    expect(result.passed).toBe(false);
    expect(result.reason_code).toBe("safety_check_failed");
  });
});

// ---------------------------------------------------------------------------
// RegistryBackedEvaluator
// ---------------------------------------------------------------------------

describe("RegistryBackedEvaluator", () => {
  it("delegates to registered evaluator", () => {
    const reg = EvaluatorRegistry.withDefaults();
    const evaluator = new RegistryBackedEvaluator(reg);
    const result = evaluator.evaluate(
      { code: "json_parseable" },
      '{"valid": true}',
    );
    expect(result.status).toBe(GateStatus.Passed);
  });

  it("returns failed status for missing evaluator", () => {
    const reg = new EvaluatorRegistry();
    const evaluator = new RegistryBackedEvaluator(reg);
    const result = evaluator.evaluate({ code: "unknown_gate" }, "response");
    expect(result.status).toBe(GateStatus.Failed);
    expect(result.reason_code).toBe("evaluator_missing");
  });

  it("returns failed status for failed evaluation", () => {
    const reg = EvaluatorRegistry.withDefaults();
    const evaluator = new RegistryBackedEvaluator(reg);
    const result = evaluator.evaluate(
      { code: "json_parseable" },
      "not valid json",
    );
    expect(result.status).toBe(GateStatus.Failed);
    expect(result.reason_code).toBe("json_parse_error");
  });

  it("propagates score from evaluator result", () => {
    const reg = EvaluatorRegistry.withDefaults({
      extra: {
        custom_regex: new RegexPredicateEvaluator({
          defaultPattern: "\\d+",
        }),
      },
    });
    const evaluator = new RegistryBackedEvaluator(reg);
    const result = evaluator.evaluate(
      { code: "custom_regex" },
      "contains 42 numbers",
    );
    expect(result.status).toBe(GateStatus.Passed);
    expect(result.observed_number).toBe(1.0);
  });

  it("propagates score 0 for non-matching regex", () => {
    const reg = EvaluatorRegistry.withDefaults({
      extra: {
        custom_regex: new RegexPredicateEvaluator({
          defaultPattern: "\\d+",
        }),
      },
    });
    const evaluator = new RegistryBackedEvaluator(reg);
    const result = evaluator.evaluate(
      { code: "custom_regex" },
      "no numbers here",
    );
    expect(result.status).toBe(GateStatus.Failed);
    expect(result.observed_number).toBe(0.0);
  });

  it("sets gate code on returned GateResult", () => {
    const reg = EvaluatorRegistry.withDefaults();
    const evaluator = new RegistryBackedEvaluator(reg);
    const result = evaluator.evaluate(
      { code: "json_parseable" },
      '{"ok": true}',
    );
    expect(result.code).toBe("json_parseable");
  });
});

// ---------------------------------------------------------------------------
// EvaluatorResult type
// ---------------------------------------------------------------------------

describe("EvaluatorResult", () => {
  it("supports minimal result with just passed", () => {
    const r: EvaluatorResult = { passed: true };
    expect(r.passed).toBe(true);
    expect(r.score).toBeUndefined();
    expect(r.reason_code).toBeUndefined();
    expect(r.safe_metadata).toBeUndefined();
  });

  it("supports full result with all fields", () => {
    const r: EvaluatorResult = {
      passed: false,
      score: 0.5,
      reason_code: "low_score",
      safe_metadata: { evaluator_name: "test" },
    };
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.reason_code).toBe("low_score");
    expect(r.safe_metadata).toEqual({ evaluator_name: "test" });
  });
});

// ---------------------------------------------------------------------------
// OutputQualityEvaluator interface conformance
// ---------------------------------------------------------------------------

describe("OutputQualityEvaluator interface", () => {
  it("all built-in evaluators implement the interface", () => {
    const evaluators: OutputQualityEvaluator[] = [
      new JsonParseableEvaluator(),
      new JsonSchemaEvaluator(),
      new ToolCallValidEvaluator(),
      new RegexPredicateEvaluator(),
      new SafetyPassedEvaluator(),
    ];

    for (const ev of evaluators) {
      expect(typeof ev.name).toBe("string");
      expect(ev.name.length).toBeGreaterThan(0);
      expect(typeof ev.evaluate).toBe("function");
    }
  });

  it("evaluators have distinct names", () => {
    const evaluators: OutputQualityEvaluator[] = [
      new JsonParseableEvaluator(),
      new JsonSchemaEvaluator(),
      new ToolCallValidEvaluator(),
      new RegexPredicateEvaluator(),
      new SafetyPassedEvaluator(),
    ];
    const names = evaluators.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
