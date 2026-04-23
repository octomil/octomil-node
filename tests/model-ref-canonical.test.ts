/**
 * Fixture-driven conformance tests for parseModelRef.
 *
 * Uses the canonical contract fixture mirrored from octomil-contracts:
 * tests/fixtures/contract_parse_cases.json
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseModelRef } from "../src/runtime/routing/model-ref-parser.js";

interface ContractCase {
  id: string;
  input: string;
  expected: {
    kind: string;
    raw: string;
    model_slug?: string;
    app_slug?: string;
    capability?: string;
    deployment_id?: string;
    experiment_id?: string;
    variant_id?: string;
  };
}

interface ContractFixture {
  description: string;
  cases: ContractCase[];
}

const fixturePath = join(__dirname, "fixtures", "contract_parse_cases.json");
const fixture: ContractFixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
const cases = fixture.cases;

describe("fixture-driven model ref conformance", () => {
  it.each(cases.map((c) => [c.id, c]))("%s", (_id, c) => {
    const result = parseModelRef(c.input);
    const expected = c.expected;

    expect(result.kind).toBe(expected.kind);
    expect(result.raw).toBe(expected.raw);
    expect(result.modelSlug).toBe(expected.model_slug);
    expect(result.appSlug).toBe(expected.app_slug);
    expect(result.capability).toBe(expected.capability);
    expect(result.deploymentId).toBe(expected.deployment_id);
    expect(result.experimentId).toBe(expected.experiment_id);
    expect(result.variantId).toBe(expected.variant_id);
  });

  it("fixture covers all 8 canonical kinds", () => {
    const expectedKinds = new Set([
      "model",
      "app",
      "capability",
      "deployment",
      "experiment",
      "alias",
      "default",
      "unknown",
    ]);
    const covered = new Set(cases.map((c) => c.expected.kind));
    expect(covered).toEqual(expectedKinds);
  });
});
