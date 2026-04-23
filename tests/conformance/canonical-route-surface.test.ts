/**
 * Route surface conformance test.
 *
 * The runtime router exposes one public metadata shape: the contract-generated
 * nested RouteMetadata object. The old flat routeMetadata/canonicalMetadata
 * compatibility bridge is intentionally gone.
 */

import { describe, expect, it } from "vitest";
import { RequestRouter } from "../../src/runtime/routing/request-router.js";
import type { RouteMetadata } from "../../src/runtime/routing/request-router.js";

const CLOUD_ENDPOINT = "https://api.octomil.com/v2";

describe("route surface hard cutover", () => {
  it("populates the generated nested metadata on legacy resolution", () => {
    const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
    const decision = router.resolve({
      model: "gemma-2b",
      capability: "chat",
      streaming: false,
    });

    const meta: RouteMetadata = decision.routeMetadata;

    expect(meta.status).toBe("selected");
    expect(meta.execution?.locality).toBe("cloud");
    expect(meta.execution?.mode).toBe("hosted_gateway");
    expect(meta.model.requested.ref).toBe("gemma-2b");
    expect(meta.model.requested.kind).toBe("model");
    expect(meta.planner.source).toBe("offline");
    expect(meta.fallback.used).toBe(false);
  });

  it("populates the generated nested metadata on planner resolution", () => {
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

    expect(decision.routeMetadata.status).toBe("selected");
    expect(decision.routeMetadata.execution?.locality).toBe("cloud");
    expect(decision.routeMetadata.planner.source).toBe("server");
  });

  it("contains the contract-required nested structure", () => {
    const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
    const decision = router.resolve({
      model: "@app/myapp/chat",
      capability: "chat",
      streaming: false,
    });

    const meta = decision.routeMetadata;

    expect(meta).toHaveProperty("status");
    expect(meta).toHaveProperty("execution");
    expect(meta).toHaveProperty("model");
    expect(meta).toHaveProperty("artifact");
    expect(meta).toHaveProperty("planner");
    expect(meta).toHaveProperty("fallback");
    expect(meta).toHaveProperty("reason");
    expect(meta.model).toHaveProperty("requested");
    expect(meta.model.requested).toHaveProperty("ref");
    expect(meta.model.requested).toHaveProperty("kind");
    expect(meta.model).toHaveProperty("resolved");
    expect(meta.model.requested.kind).toBe("app");
  });

  it("normalizes planner source at the output boundary", () => {
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

    expect(decision.routeMetadata.planner.source).toBe("server");
  });

  it("does not expose the removed compatibility fields", () => {
    const router = new RequestRouter({ cloudEndpoint: CLOUD_ENDPOINT });
    const decision = router.resolve({
      model: "gemma-2b",
      capability: "chat",
      streaming: false,
    }) as unknown as Record<string, unknown>;

    expect(decision.canonicalMetadata).toBeUndefined();
    expect((decision.routeMetadata as Record<string, unknown>).locality).toBeUndefined();
    expect((decision.routeMetadata as Record<string, unknown>).mode).toBeUndefined();
    expect((decision.routeMetadata as Record<string, unknown>).modelRefKind).toBeUndefined();
  });
});
