/**
 * PlannerClient — fetches runtime plans from the server planner API.
 *
 * The planner resolves model refs (app/capability/deployment/experiment)
 * into concrete candidate lists with locality, engine, gates, and policy.
 *
 * This is the SDK-side client; the server does the actual planning.
 */

import type { CandidatePlan } from "./attempt-runner.js";
import type { PlannerResult, RoutableCapability } from "./request-router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlannerClientConfig {
  serverUrl: string;
  apiKey: string;
}

export interface PlanRequest {
  model: string;
  capability: RoutableCapability;
  streaming?: boolean;
  routing_policy?: string;
}

/** Raw planner response from the server. */
interface PlannerApiResponse {
  model: string;
  capability: string;
  policy: string;
  candidates: CandidatePlan[];
  fallback_candidates?: CandidatePlan[];
  fallback_allowed: boolean;
  plan_id?: string;
  planner_source?: string;
  app_resolution?: {
    app_id?: string;
    app_slug?: string;
    [key: string]: unknown;
  };
  server_generated_at?: string;
  plan_ttl_seconds?: number;
}

// ---------------------------------------------------------------------------
// PlannerClient
// ---------------------------------------------------------------------------

export class PlannerClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;

  constructor(config: PlannerClientConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  /**
   * Fetch a runtime plan for the given model and capability.
   *
   * Returns null if the planner is unavailable or returns an error
   * (graceful degradation — caller falls back to legacy direct route).
   */
  async getPlan(request: PlanRequest): Promise<PlannerResult | null> {
    const url = `${this.serverUrl}/api/v1/runtime/plan`;

    let response: Response;
    try {
      response = await fetch(url, {
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
        }),
      });
    } catch {
      // Network error — graceful degradation
      return null;
    }

    if (!response.ok) {
      // Planner unavailable or returned error — graceful degradation
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
      };
    } catch {
      return null;
    }
  }
}
