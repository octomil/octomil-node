/**
 * Canonical route surface conformance test.
 *
 * Verifies that the RequestRouter populates the contract-backed
 * canonicalMetadata field alongside the deprecated flat routeMetadata,
 * and that the canonical shape matches the contract structure.
 */

import { describe, expect, it } from "vitest";
import { RequestRouter } from "../../src/runtime/routing/request-router.js";
import type { CanonicalRouteMetadata } from "../../src/runtime/routing/request-router.js";

const CLOUD_ENDPOINT = "https://api.octomil.com/v2";

describe("canonical route surface", () => {
  describe("RoutingDecision.canonicalMetadata", () => {
    it("is populated on legacy (no plan) resolution", () => {
      const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
      const decision = router.resolve({
        model: "gemma-2b",
        capability: "chat",
        streaming: false,
      });

      expect(decision.canonicalMetadata).toBeDefined();
      const meta: CanonicalRouteMetadata = decision.canonicalMetadata;

      expect(meta.status).toBe("selected");
      expect(meta.execution).toBeDefined();
      expect(meta.execution!.locality).toBe("cloud");
      expect(meta.execution!.mode).toBe("hosted_gateway");
      expect(meta.model.requested.ref).toBe("gemma-2b");
      expect(meta.model.requested.kind).toBe("model");
      expect(meta.planner.source).toBe("offline");
      expect(meta.fallback.used).toBe(false);
    });

    it("is populated on plan-based resolution", () => {
      const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
      const decision = router.resolve({
        model: "gemma-2b",
        capability: "chat",
        streaming: false,
        plannerResult: {
          model: "gemma-2b",
          capability: "chat",
          policy: "cloud_only",
          candidates: [
            {
              locality: "cloud",
              engine: "cloud",
              priority: 0,
              confidence: 1,
              reason: "cloud primary",
            },
          ],
          fallback_allowed: false,
          planner_source: "server",
        },
      });

      const meta = decision.canonicalMetadata;
      expect(meta.status).toBe("selected");
      expect(meta.execution!.locality).toBe("cloud");
      expect(meta.planner.source).toBe("server");
    });

    it("has contract-required nested structure", () => {
      const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
      const decision = router.resolve({
        model: "@app/myapp/chat",
        capability: "chat",
        streaming: false,
      });

      const meta = decision.canonicalMetadata;

      // All top-level contract fields present
      expect(meta).toHaveProperty("status");
      expect(meta).toHaveProperty("execution");
      expect(meta).toHaveProperty("model");
      expect(meta).toHaveProperty("artifact");
      expect(meta).toHaveProperty("planner");
      expect(meta).toHaveProperty("fallback");
      expect(meta).toHaveProperty("reason");

      // Nested model structure
      expect(meta.model).toHaveProperty("requested");
      expect(meta.model.requested).toHaveProperty("ref");
      expect(meta.model.requested).toHaveProperty("kind");
      expect(meta.model).toHaveProperty("resolved");

      // Model ref kind correctly parsed
      expect(meta.model.requested.kind).toBe("app");
    });

    it("normalizes planner source in canonical metadata", () => {
      const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
      const decision = router.resolve({
        model: "gemma-2b",
        capability: "chat",
        streaming: false,
        plannerResult: {
          model: "gemma-2b",
          capability: "chat",
          policy: "auto",
          candidates: [
            {
              locality: "cloud",
              engine: "cloud",
              priority: 0,
              confidence: 1,
              reason: "test",
            },
          ],
          fallback_allowed: true,
          planner_source: "server_plan",
        },
      });

      // server_plan should be normalized to "server"
      expect(decision.canonicalMetadata.planner.source).toBe("server");
    });
  });

  describe("backward compatibility", () => {
    it("flat routeMetadata is still populated", () => {
      const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
      const decision = router.resolve({
        model: "gemma-2b",
        capability: "chat",
        streaming: false,
      });

      // Flat shape still present for backward compat
      expect(decision.routeMetadata).toBeDefined();
      expect(decision.routeMetadata.locality).toBe("cloud");
      expect(decision.routeMetadata.mode).toBe("hosted_gateway");
      expect(decision.routeMetadata.modelRefKind).toBe("model");
    });

    it("both shapes agree on locality and mode", () => {
      const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
      const decision = router.resolve({
        model: "gemma-2b",
        capability: "chat",
        streaming: false,
      });

      expect(decision.canonicalMetadata.execution!.locality).toBe(decision.routeMetadata.locality);
      expect(decision.canonicalMetadata.execution!.mode).toBe(decision.routeMetadata.mode);
    });
  });
});
