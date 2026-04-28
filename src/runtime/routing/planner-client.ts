/**
 * PlannerClient — fetches runtime plans from the server planner API.
 */

import { collectDeviceRuntimeProfile } from "../../planner/device-profile.js";
import type { DeviceRuntimeProfile } from "../../planner/types.js";
import type { CandidatePlan } from "./attempt-runner.js";
import type { PlannerResult, RoutableCapability } from "./request-router.js";

export interface PlannerClientConfig {
  serverUrl: string;
  apiKey: string;
}

export interface PlanRequest {
  model: string;
  capability: RoutableCapability;
  streaming?: boolean;
  routing_policy?: string;
  /** Slug or `@app/<slug>` ref for app-scoped resolution. Preserved
   *  through the planner so `private`/`local_only` apps never collide
   *  with the public artifact namespace. */
  app_slug?: string;
  device?: DeviceRuntimeProfile;
}

/** Resolution metadata for non-app model ref types (deployment, experiment, etc.). */
export interface ModelResolution {
  ref_kind: string;
  original_ref: string;
  resolved_model: string;
  deployment_id?: string;
  deployment_key?: string;
  experiment_id?: string;
  variant_id?: string;
  variant_name?: string;
  capability?: string;
  routing_policy?: string;
}

interface PlannerApiResponse {
  model: string;
  capability: string;
  policy: string;
  candidates: CandidatePlan[];
  fallback_allowed: boolean;
  plan_id?: string;
  planner_source?: string;
  app_resolution?: {
    app_id?: string;
    app_slug?: string;
    [key: string]: unknown;
  };
  resolution?: ModelResolution;
}

export class PlannerClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(config: PlannerClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  async getPlan(request: PlanRequest): Promise<PlannerResult | null> {
    let response: Response;
    try {
      const device = request.device ?? await collectDeviceRuntimeProfile();
      response = await fetch(`${this.serverUrl}/api/v2/runtime/plan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "octomil-node/1.0",
        },
        body: JSON.stringify({
          model: request.model,
          capability: request.capability,
          streaming: request.streaming ?? false,
          routing_policy: request.routing_policy,
          app_slug: request.app_slug,
          device,
        }),
      });
    } catch {
      return null;
    }

    if (!response.ok) {
      return null;
    }

    try {
      const data = (await response.json()) as PlannerApiResponse;
      return {
        model: data.model,
        capability: data.capability,
        policy: data.policy,
        candidates: data.candidates,
        fallback_allowed: data.fallback_allowed,
        plan_id: data.plan_id,
        planner_source: data.planner_source ?? "server",
        app_resolution: data.app_resolution,
        resolution: data.resolution,
      };
    } catch {
      return null;
    }
  }
}
