/**
 * RequestRouter — integrates planner candidates with production request paths.
 *
 * The Node SDK is server-side. Primary execution modes:
 * - `hosted_gateway` (cloud) — default path for all capabilities
 * - `external_endpoint` — user's local `octomil serve` instance (opt-in)
 * - `sdk_runtime` — injected local runtime when the caller provides one
 *
 * In the default hosted Node path, "local" usually means an explicit local
 * endpoint. Callers may also inject an in-process runtime checker/executor.
 *
 * When a PlannerResult is available (from server planner API), the router
 * uses CandidateAttemptRunner to evaluate candidates end-to-end. When no
 * plan is available, it falls back to legacy direct hosted behavior.
 */

import {
  CandidateAttemptRunner,
  type AttemptLoopResult,
  type CandidatePlan,
  type RuntimeChecker,
  type GateEvaluator,
} from "./attempt-runner.js";
import { parseModelRef, type ParsedModelRef } from "./model-ref-parser.js";
import { buildRouteEvent, type RouteEvent } from "./route-event.js";
import {
  normalizePlannerSource,
  type RouteMetadata as ContractRouteMetadata,
  type RouteExecution,
  type RouteModel,
  type PlannerInfo,
  type FallbackInfo,
  type RouteReason,
} from "../../planner/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Capability surface being routed. */
export type RoutableCapability = "chat" | "embeddings" | "audio" | "responses";

/** A planner result from the server planner API. */
export interface PlannerResult {
  /** Resolved model ID from the server. */
  model: string;
  capability: string;
  policy: string;
  candidates: CandidatePlan[];
  fallback_allowed: boolean;
  /** Opaque plan ID for telemetry correlation. */
  plan_id?: string;
  /** Where the plan came from. */
  planner_source?: string;
  /** App resolution metadata (for @app refs). */
  app_resolution?: {
    app_id?: string;
    app_slug?: string;
    [key: string]: unknown;
  };
  /** Model resolution metadata for deployment/experiment/capability refs. */
  resolution?: {
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
  };
}

/** Input context for a routing decision. */
export interface RequestRoutingContext {
  /** Model string as provided by the caller (may be a ref). */
  model: string;
  /** Capability surface being invoked. */
  capability: RoutableCapability;
  /** Whether the request is streaming. */
  streaming: boolean;
  /** Planner result if one was obtained from the server. */
  plannerResult?: PlannerResult;
  /** Request-level routing policy override. */
  routingPolicy?: string;
  /** Unique request ID for telemetry correlation. */
  requestId?: string;
}

/**
 * Route metadata attached to the response object.
 *
 * @deprecated Use {@link CanonicalRouteMetadata} (the contract-backed nested shape)
 * instead. This flat shape is retained for backward compatibility and will be
 * removed in a future major version. Access the canonical shape via
 * `RoutingDecision.canonicalMetadata`.
 */
export interface RouteMetadata {
  /** Parsed model reference kind. */
  modelRefKind: string;
  /** Parsed model reference. */
  parsedRef: ParsedModelRef;
  /** Final locality where inference ran. */
  locality: "local" | "cloud";
  /** Execution mode used. */
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  /** Endpoint URL used for the request. */
  endpoint: string;
  /** Whether a planner plan was used (vs legacy direct route). */
  plannerUsed: boolean;
  /** Attempt loop result from CandidateAttemptRunner (if plan was used). */
  attemptResult?: AttemptLoopResult;
  /** Built route event for telemetry. */
  routeEvent?: RouteEvent;
}

/**
 * Contract-backed canonical route metadata shape.
 *
 * Re-export from `planner/types.ts` for convenience. This is the canonical
 * nested shape defined in octomil-contracts, shared across all SDKs.
 * Prefer this over the flat {@link RouteMetadata}.
 */
export type { ContractRouteMetadata as CanonicalRouteMetadata };

/** Output of RequestRouter.resolve(). */
export interface RoutingDecision {
  /** Where inference will run. */
  locality: "local" | "cloud";
  /** Execution mode. */
  mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint";
  /** Endpoint URL to send the request to. */
  endpoint: string;
  /**
   * Flat route metadata for response attachment.
   * @deprecated Use {@link canonicalMetadata} instead.
   */
  routeMetadata: RouteMetadata;
  /** Contract-backed canonical route metadata (nested shape). */
  canonicalMetadata: ContractRouteMetadata;
  /** Attempt loop result. */
  attemptResult: AttemptLoopResult;
}

/** Configuration for the RequestRouter. */
export interface RouterConfig {
  /** Base URL for cloud (hosted gateway). */
  cloudEndpoint: string;
  /** Optional external endpoint URL (user's local serve instance). */
  externalEndpoint?: string;
  /** API key for cloud requests. */
  apiKey?: string;
  /** Custom runtime checker. */
  runtimeChecker?: RuntimeChecker;
  /** Custom gate evaluator. */
  gateEvaluator?: GateEvaluator;
}

// ---------------------------------------------------------------------------
// Capabilities that support external_endpoint routing
// ---------------------------------------------------------------------------

/**
 * Only chat and responses support external_endpoint routing.
 * Embeddings and audio are cloud-only in the Node SDK unless an
 * external_endpoint is explicitly configured.
 */
const EXTERNAL_ENDPOINT_CAPABLE: Set<RoutableCapability> = new Set([
  "chat",
  "responses",
  "embeddings",
]);

// ---------------------------------------------------------------------------
// RequestRouter
// ---------------------------------------------------------------------------

export class RequestRouter {
  private readonly config: RouterConfig;

  constructor(config: RouterConfig) {
    this.config = config;
  }

  /**
   * Resolve the routing decision for a request.
   *
   * When a planner result is available, runs the CandidateAttemptRunner
   * to evaluate candidates end-to-end. When no plan is available, falls
   * back to legacy direct hosted behavior.
   *
   * @param ctx - Request routing context.
   * @returns Routing decision with endpoint, metadata, and attempt result.
   */
  resolve(ctx: RequestRoutingContext): RoutingDecision {
    const parsedRef = parseModelRef(ctx.model);
    const requestId =
      ctx.requestId ?? `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    // If we have a planner result, use the attempt runner
    if (ctx.plannerResult) {
      return this.resolveWithPlan(ctx, parsedRef, requestId);
    }

    // No plan — fall back to legacy direct hosted
    return this.resolveLegacy(ctx, parsedRef, requestId);
  }

  /**
   * Resolve using planner candidates via CandidateAttemptRunner.
   */
  private resolveWithPlan(
    ctx: RequestRoutingContext,
    parsedRef: ParsedModelRef,
    requestId: string,
  ): RoutingDecision {
    const plan = ctx.plannerResult!;
    const fallbackAllowed = plan.fallback_allowed && !this.isPolicyRestricted(ctx);

    // Build a runtime checker that understands Node SDK capabilities
    const runtimeChecker = this.buildRuntimeChecker(ctx.capability);

    const runner = new CandidateAttemptRunner({
      fallbackAllowed,
      streaming: ctx.streaming,
    });

    const result = this.normalizeAttemptModes(
      runner.run(plan.candidates, {
        runtimeChecker,
        gateEvaluator: this.config.gateEvaluator,
      }),
      ctx.capability,
    );

    const selected = result.selectedAttempt;
    const locality = selected?.locality ?? "cloud";
    const mode = selected?.mode ?? this.resolveMode(locality, ctx.capability);
    const endpoint = this.endpointForMode(mode);

    // Build route event for telemetry
    const routeEvent = buildRouteEvent({
      requestId,
      capability: ctx.capability,
      streaming: ctx.streaming,
      model: ctx.model,
      modelRefKind: parsedRef.kind,
      policy: plan.policy,
      plannerSource: normalizePlannerSource(plan.planner_source ?? "server"),
      planId: plan.plan_id,
      attemptResult: result,
      deploymentId: parsedRef.deploymentId,
      experimentId: parsedRef.experimentId,
      variantId: parsedRef.variantId,
      appId: plan.app_resolution?.app_id,
      appSlug: plan.app_resolution?.app_slug ?? parsedRef.appSlug,
    });

    return {
      locality,
      mode,
      endpoint,
      routeMetadata: {
        modelRefKind: parsedRef.kind,
        parsedRef,
        locality,
        mode,
        endpoint,
        plannerUsed: true,
        attemptResult: result,
        routeEvent,
      },
      canonicalMetadata: this.buildCanonicalMetadata(
        parsedRef,
        locality,
        mode,
        plan.planner_source ?? "server",
        plan.policy,
        result,
      ),
      attemptResult: result,
    };
  }

  /**
   * Legacy resolution — no planner plan available.
   *
   * Always routes to cloud (hosted_gateway) as the default path.
   * This is backward-compatible with how the SDK worked before planner
   * integration.
   */
  private resolveLegacy(
    ctx: RequestRoutingContext,
    parsedRef: ParsedModelRef,
    requestId: string,
  ): RoutingDecision {
    // Synthesize a single cloud candidate
    const candidates: CandidatePlan[] = [
      {
        locality: "cloud",
        engine: "cloud",
        priority: 0,
        confidence: 1,
        reason: "legacy direct hosted (no planner plan)",
      },
    ];

    const runner = new CandidateAttemptRunner({
      fallbackAllowed: false,
      streaming: ctx.streaming,
    });

    const runtimeChecker = this.buildRuntimeChecker(ctx.capability);
    const result = this.normalizeAttemptModes(
      runner.run(candidates, {
        runtimeChecker,
        gateEvaluator: this.config.gateEvaluator,
      }),
      ctx.capability,
    );

    const selected = result.selectedAttempt;
    const mode = selected?.mode ?? "hosted_gateway";
    const endpoint = this.endpointForMode(mode);

    const routeEvent = buildRouteEvent({
      requestId,
      capability: ctx.capability,
      streaming: ctx.streaming,
      model: ctx.model,
      modelRefKind: parsedRef.kind,
      plannerSource: "offline",
      attemptResult: result,
      deploymentId: parsedRef.deploymentId,
      experimentId: parsedRef.experimentId,
      variantId: parsedRef.variantId,
    });

    return {
      locality: "cloud",
      mode,
      endpoint,
      routeMetadata: {
        modelRefKind: parsedRef.kind,
        parsedRef,
        locality: "cloud",
        mode,
        endpoint,
        plannerUsed: false,
        attemptResult: result,
        routeEvent,
      },
      canonicalMetadata: this.buildCanonicalMetadata(
        parsedRef,
        "cloud",
        mode,
        "offline",
        undefined,
        result,
      ),
      attemptResult: result,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Build a runtime checker for the Node SDK.
   *
   * Cloud is always available. "Local" (external_endpoint) is available
   * only when an externalEndpoint is configured and the capability supports it.
   */
  private buildRuntimeChecker(capability: RoutableCapability): RuntimeChecker {
    const externalConfigured = !!this.config.externalEndpoint;
    const capabilitySupportsExternal = EXTERNAL_ENDPOINT_CAPABLE.has(capability);
    const injected = this.config.runtimeChecker;

    return {
      check: (engine, locality) => {
        // Delegate to injected checker first if present
        if (injected) {
          return injected.check(engine, locality);
        }

        if (locality === "cloud") {
          return { available: true };
        }

        // Node SDK: "local" means external_endpoint
        if (externalConfigured && capabilitySupportsExternal) {
          return { available: true };
        }

        return {
          available: false,
          reasonCode: externalConfigured
            ? "capability_not_supported_locally"
            : "no_external_endpoint_configured",
        };
      },
    };
  }

  /**
   * Resolve execution mode from locality.
   *
   * In the hosted Node SDK:
   * - cloud -> hosted_gateway
   * - local -> external_endpoint when configured, otherwise sdk_runtime
   */
  private resolveMode(
    locality: "local" | "cloud",
    capability: RoutableCapability,
  ): "sdk_runtime" | "hosted_gateway" | "external_endpoint" {
    if (locality === "cloud") {
      return "hosted_gateway";
    }
    return this.supportsExternalEndpoint(capability) ? "external_endpoint" : "sdk_runtime";
  }

  /**
   * Get the endpoint URL for a given mode.
   */
  private endpointForMode(
    mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint",
  ): string {
    if (mode === "external_endpoint" && this.config.externalEndpoint) {
      return this.config.externalEndpoint;
    }
    if (mode === "sdk_runtime") {
      return "";
    }
    return this.config.cloudEndpoint;
  }

  /**
   * Check if the routing policy restricts to a single locality.
   */
  private isPolicyRestricted(ctx: RequestRoutingContext): boolean {
    const policy = ctx.routingPolicy ?? ctx.plannerResult?.policy;
    return policy === "private" || policy === "local_only";
  }

  private supportsExternalEndpoint(capability: RoutableCapability): boolean {
    return !!this.config.externalEndpoint && EXTERNAL_ENDPOINT_CAPABLE.has(capability);
  }

  /**
   * Build the canonical contract-backed route metadata from routing context.
   */
  private buildCanonicalMetadata(
    parsedRef: ParsedModelRef,
    locality: "local" | "cloud",
    mode: "sdk_runtime" | "hosted_gateway" | "external_endpoint",
    plannerSource: string,
    policy?: string,
    attemptResult?: AttemptLoopResult,
    engine?: string | null,
  ): ContractRouteMetadata {
    const execution: RouteExecution = {
      locality,
      mode,
      engine: engine ?? attemptResult?.selectedAttempt?.engine ?? null,
    };

    const model: RouteModel = {
      requested: {
        ref: parsedRef.raw,
        kind: parsedRef.kind as ContractRouteMetadata["model"]["requested"]["kind"],
        capability: null,
      },
      resolved: null,
    };

    const planner: PlannerInfo = {
      source: normalizePlannerSource(plannerSource) as ContractRouteMetadata["planner"]["source"],
    };

    const fallback: FallbackInfo = {
      used: attemptResult?.fallbackUsed ?? false,
    };

    const reason: RouteReason = {
      code: attemptResult?.selectedAttempt
        ? "ok"
        : "no_candidate",
      message: attemptResult?.selectedAttempt?.reason ?? "direct hosted",
    };

    return {
      status: attemptResult?.selectedAttempt ? "selected" : "unavailable",
      execution,
      model,
      artifact: null,
      planner,
      fallback,
      reason,
    };
  }

  private normalizeAttemptModes(
    result: AttemptLoopResult,
    capability: RoutableCapability,
  ): AttemptLoopResult {
    const localMode: "external_endpoint" | "sdk_runtime" = this.supportsExternalEndpoint(capability)
      ? "external_endpoint"
      : "sdk_runtime";

    const normalizeAttempt = (
      attempt: AttemptLoopResult["attempts"][number],
    ): AttemptLoopResult["attempts"][number] =>
      attempt.locality === "local" ? { ...attempt, mode: localMode } : attempt;

    return {
      ...result,
      attempts: result.attempts.map(normalizeAttempt),
      selectedAttempt: result.selectedAttempt
        ? normalizeAttempt(result.selectedAttempt)
        : null,
    };
  }
}
