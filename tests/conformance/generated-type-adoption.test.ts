/**
 * Contract-generated type adoption conformance test.
 *
 * Verifies that the generated enum values from octomil-contracts match
 * the expected canonical values used across all SDKs.
 */

import { describe, expect, it } from "vitest";
import { PlannerSource } from "../../src/_generated/planner_source.js";
import { CacheStatus } from "../../src/_generated/cache_status.js";
import { ArtifactCacheStatus } from "../../src/_generated/artifact_cache_status.js";
import { ExecutionMode } from "../../src/_generated/execution_mode.js";
import { RouteLocality } from "../../src/_generated/route_locality.js";
import { RouteMode } from "../../src/_generated/route_mode.js";
import { ModelRefKind } from "../../src/_generated/model_ref_kind.js";
import { FallbackTriggerStage } from "../../src/_generated/fallback_trigger_stage.js";
import { RoutingPolicy } from "../../src/_generated/routing_policy.js";

// Also verify re-exports from planner/types.ts
import {
  ContractPlannerSource,
  ContractCacheStatus,
  ContractRouteLocality,
  ContractRouteMode,
  ContractModelRefKind,
  CANONICAL_PLANNER_SOURCES,
} from "../../src/planner/types.js";

describe("contract-generated type adoption", () => {
  describe("PlannerSource", () => {
    it("has exactly 3 canonical values", () => {
      expect(Object.values(PlannerSource)).toEqual(["server", "cache", "offline"]);
    });

    it("re-exports match direct import", () => {
      expect(ContractPlannerSource).toBe(PlannerSource);
    });

    it("CANONICAL_PLANNER_SOURCES uses generated values", () => {
      expect(CANONICAL_PLANNER_SOURCES.has("server")).toBe(true);
      expect(CANONICAL_PLANNER_SOURCES.has("cache")).toBe(true);
      expect(CANONICAL_PLANNER_SOURCES.has("offline")).toBe(true);
      expect(CANONICAL_PLANNER_SOURCES.size).toBe(3);
    });
  });

  describe("CacheStatus", () => {
    it("has expected values", () => {
      expect(CacheStatus.Hit).toBe("hit");
      expect(CacheStatus.Miss).toBe("miss");
      expect(CacheStatus.Downloaded).toBe("downloaded");
      expect(CacheStatus.NotApplicable).toBe("not_applicable");
      expect(CacheStatus.Unavailable).toBe("unavailable");
    });

    it("re-exports match direct import", () => {
      expect(ContractCacheStatus).toBe(CacheStatus);
    });
  });

  describe("ArtifactCacheStatus", () => {
    it("has same values as CacheStatus", () => {
      expect(ArtifactCacheStatus.Hit).toBe("hit");
      expect(ArtifactCacheStatus.Miss).toBe("miss");
      expect(ArtifactCacheStatus.NotApplicable).toBe("not_applicable");
      expect(ArtifactCacheStatus.Unavailable).toBe("unavailable");
    });
  });

  describe("ExecutionMode", () => {
    it("has expected values", () => {
      expect(ExecutionMode.SdkRuntime).toBe("sdk_runtime");
      expect(ExecutionMode.HostedGateway).toBe("hosted_gateway");
      expect(ExecutionMode.ExternalEndpoint).toBe("external_endpoint");
    });
  });

  describe("RouteLocality", () => {
    it("has exactly 2 values", () => {
      expect(Object.values(RouteLocality)).toEqual(["local", "cloud"]);
    });

    it("re-exports match direct import", () => {
      expect(ContractRouteLocality).toBe(RouteLocality);
    });
  });

  describe("RouteMode", () => {
    it("has expected values", () => {
      expect(RouteMode.SdkRuntime).toBe("sdk_runtime");
      expect(RouteMode.ExternalEndpoint).toBe("external_endpoint");
      expect(RouteMode.HostedGateway).toBe("hosted_gateway");
    });

    it("re-exports match direct import", () => {
      expect(ContractRouteMode).toBe(RouteMode);
    });
  });

  describe("ModelRefKind", () => {
    it("has all 8 canonical kinds", () => {
      const values = Object.values(ModelRefKind);
      expect(values).toContain("model");
      expect(values).toContain("app");
      expect(values).toContain("capability");
      expect(values).toContain("deployment");
      expect(values).toContain("experiment");
      expect(values).toContain("alias");
      expect(values).toContain("default");
      expect(values).toContain("unknown");
      expect(values).toHaveLength(8);
    });

    it("re-exports match direct import", () => {
      expect(ContractModelRefKind).toBe(ModelRefKind);
    });
  });

  describe("FallbackTriggerStage", () => {
    it("has expected values", () => {
      expect(FallbackTriggerStage.Policy).toBe("policy");
      expect(FallbackTriggerStage.Prepare).toBe("prepare");
      expect(FallbackTriggerStage.Download).toBe("download");
      expect(FallbackTriggerStage.Gate).toBe("gate");
      expect(FallbackTriggerStage.Inference).toBe("inference");
      expect(FallbackTriggerStage.Timeout).toBe("timeout");
    });
  });

  describe("RoutingPolicy", () => {
    it("includes core policies", () => {
      const values = Object.values(RoutingPolicy);
      expect(values).toContain("private");
      expect(values).toContain("local_first");
      expect(values).toContain("cloud_first");
      expect(values).toContain("cloud_only");
    });
  });
});
