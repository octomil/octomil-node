/**
 * Data-driven conformance tests for parseModelRef using the canonical
 * fixture from octomil-contracts (fixtures/model_refs/canonical.json).
 *
 * The fixture is the single source of truth for model ref classification.
 * If this test fails, fix the parser -- not the fixture.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseModelRef } from "../src/runtime/routing/model-ref-parser.js";

interface CanonicalCase {
  input: string;
  expected_kind: string;
  description?: string;
  expected_app_slug?: string;
  expected_capability?: string;
  expected_deployment_id?: string;
  expected_experiment_id?: string;
  expected_variant_id?: string;
  expected_alias?: string;
}

interface CanonicalFixture {
  description: string;
  contract_version: string;
  cases: CanonicalCase[];
}

interface DeprecatedAliases {
  deprecated_to_canonical: Record<string, string>;
}

const fixtureDir = join(__dirname, "fixtures", "model_refs");
const canonical: CanonicalFixture = JSON.parse(
  readFileSync(join(fixtureDir, "canonical.json"), "utf-8"),
);
const deprecated: DeprecatedAliases = JSON.parse(
  readFileSync(join(fixtureDir, "deprecated_aliases.json"), "utf-8"),
);

const cases = canonical.cases;

// =========================================================================
// Kind classification
// =========================================================================

describe("canonical model ref kind classification", () => {
  it.each(cases.map((c) => [c.description ?? c.input ?? "<empty>", c]))(
    "kind for %s",
    (_desc, c) => {
      const result = parseModelRef(c.input);
      expect(result.kind).toBe(c.expected_kind);
    },
  );
});

// =========================================================================
// App ref field extraction
// =========================================================================

describe("app ref field extraction", () => {
  const appCases = cases.filter((c) => c.expected_kind === "app");

  it.each(appCases.map((c) => [c.input, c]))(
    "app ref fields for %s",
    (_input, c) => {
      const result = parseModelRef(c.input);
      expect(result.appSlug).toBe(c.expected_app_slug);
      expect(result.capability).toBe(c.expected_capability);
    },
  );
});

// =========================================================================
// Deployment ref field extraction
// =========================================================================

describe("deployment ref field extraction", () => {
  const deployCases = cases.filter((c) => c.expected_kind === "deployment");

  it.each(deployCases.map((c) => [c.input, c]))(
    "deployment id for %s",
    (_input, c) => {
      const result = parseModelRef(c.input);
      expect(result.deploymentId).toBe(c.expected_deployment_id);
    },
  );
});

// =========================================================================
// Experiment ref field extraction
// =========================================================================

describe("experiment ref field extraction", () => {
  const expCases = cases.filter((c) => c.expected_kind === "experiment");

  it.each(expCases.map((c) => [c.input, c]))(
    "experiment fields for %s",
    (_input, c) => {
      const result = parseModelRef(c.input);
      expect(result.experimentId).toBe(c.expected_experiment_id);
      expect(result.variantId).toBe(c.expected_variant_id);
    },
  );
});

// =========================================================================
// Deprecated aliases
// =========================================================================

describe("deprecated aliases", () => {
  const deprecatedKinds = Object.keys(deprecated.deprecated_to_canonical);

  it("parser never produces deprecated kind values", () => {
    for (const c of cases) {
      const result = parseModelRef(c.input);
      expect(deprecatedKinds).not.toContain(result.kind);
    }
  });
});

// =========================================================================
// All 8 canonical kinds covered
// =========================================================================

describe("canonical kind coverage", () => {
  it("fixture covers all 8 canonical kinds", () => {
    const expected = new Set([
      "model",
      "app",
      "capability",
      "deployment",
      "experiment",
      "alias",
      "default",
      "unknown",
    ]);
    const covered = new Set(cases.map((c) => c.expected_kind));
    expect(covered).toEqual(expected);
  });
});
