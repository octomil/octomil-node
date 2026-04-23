/**
 * Model-ref parser fixture conformance test.
 *
 * Uses the canonical fixture from octomil-contracts to verify the
 * Node SDK parser matches the expected grammar exactly.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseModelRef } from "../../src/runtime/routing/model-ref-parser.js";

interface FixtureCase {
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

interface FixtureFile {
  cases: FixtureCase[];
}

const fixtureData: FixtureFile = JSON.parse(
  readFileSync(
    resolve(__dirname, "../fixtures/model_ref_parse_cases.json"),
    "utf-8",
  ),
);

describe("model-ref parser fixture conformance", () => {
  for (const tc of fixtureData.cases) {
    it(`${tc.id}: "${tc.input}" -> ${tc.expected.kind}`, () => {
      const result = parseModelRef(tc.input);

      expect(result.kind).toBe(tc.expected.kind);
      expect(result.raw).toBe(tc.expected.raw);

      if (tc.expected.model_slug !== undefined) {
        expect(result.modelSlug).toBe(tc.expected.model_slug);
      }
      if (tc.expected.app_slug !== undefined) {
        expect(result.appSlug).toBe(tc.expected.app_slug);
      }
      if (tc.expected.capability !== undefined) {
        expect(result.capability).toBe(tc.expected.capability);
      }
      if (tc.expected.deployment_id !== undefined) {
        expect(result.deploymentId).toBe(tc.expected.deployment_id);
      }
      if (tc.expected.experiment_id !== undefined) {
        expect(result.experimentId).toBe(tc.expected.experiment_id);
      }
      if (tc.expected.variant_id !== undefined) {
        expect(result.variantId).toBe(tc.expected.variant_id);
      }
    });
  }
});
