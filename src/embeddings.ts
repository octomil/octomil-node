/**
 * Cloud embeddings via POST /api/v1/embeddings.
 *
 * Calls the Octomil embeddings endpoint and returns dense vectors
 * suitable for semantic search, clustering, and RAG pipelines.
 *
 * Supports planner-routed execution when a PlannerClient is available.
 */

import { OctomilError } from "./types.js";
import {
  RequestRouter,
  type RouteMetadata,
} from "./runtime/routing/request-router.js";
import type { PlannerClient } from "./runtime/routing/planner-client.js";
import type { RouteEvent } from "./runtime/routing/route-event.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token usage statistics from the embeddings endpoint. */
export interface EmbeddingUsage {
  promptTokens: number;
  totalTokens: number;
}

/** Result returned by `embed()`. */
export interface EmbeddingResult {
  embeddings: number[][];
  model: string;
  usage: EmbeddingUsage;
}

/** Configuration for the embedding client. */
export interface EmbeddingConfig {
  serverUrl: string;
  apiKey: string;
}

/** Raw API response shape. */
interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---------------------------------------------------------------------------
// embed()
// ---------------------------------------------------------------------------

/**
 * Generate embeddings via the Octomil cloud endpoint.
 *
 * @param config - Server URL and API key.
 * @param modelId - Embedding model identifier (e.g. `"nomic-embed-text"`).
 * @param input - A single string or array of strings to embed.
 * @param signal - Optional AbortSignal for cancellation.
 * @returns `EmbeddingResult` with dense vectors, model name, and usage.
 */
export async function embed(
  config: EmbeddingConfig,
  modelId: string,
  input: string | string[],
  signal?: AbortSignal,
): Promise<EmbeddingResult> {
  if (!config.serverUrl) {
    throw new OctomilError(
      "INVALID_INPUT",
      "serverUrl is required for embed()",
    );
  }
  if (!config.apiKey) {
    throw new OctomilError("INVALID_INPUT", "apiKey is required for embed()");
  }

  const url = `${config.serverUrl.replace(/\/+$/, "")}/api/v1/embeddings`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model_id: modelId, input }),
      signal,
    });
  } catch (err) {
    throw new OctomilError(
      "NETWORK_UNAVAILABLE",
      `embed() request failed: ${String(err)}`,
      err,
    );
  }

  if (!response.ok) {
    throw new OctomilError(
      "INFERENCE_FAILED",
      `embed() failed: HTTP ${response.status}`,
    );
  }

  const data = (await response.json()) as EmbeddingResponse;

  return {
    embeddings: data.data.map((d) => d.embedding),
    model: data.model,
    usage: {
      promptTokens: data.usage.prompt_tokens,
      totalTokens: data.usage.total_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// embedWithPlanner() — planner-routed embedding
// ---------------------------------------------------------------------------

/** Configuration for planner-routed embeddings. */
export interface PlannerEmbeddingConfig extends EmbeddingConfig {
  plannerClient: PlannerClient;
}

/** Route info from a planner-routed embedding request. */
export interface EmbeddingRouteInfo {
  routeMetadata?: RouteMetadata;
  routeEvent?: RouteEvent;
}

/**
 * Generate embeddings via planner-routed execution.
 *
 * Fetches a plan from the server planner, evaluates candidates, then
 * executes embedding via the selected cloud endpoint. Falls back to
 * direct cloud if the planner is unavailable.
 *
 * @param config - Server URL, API key, and planner client.
 * @param modelId - Embedding model identifier.
 * @param input - A single string or array of strings to embed.
 * @param signal - Optional AbortSignal for cancellation.
 * @returns Embedding result with route info.
 */
export async function embedWithPlanner(
  config: PlannerEmbeddingConfig,
  modelId: string,
  input: string | string[],
  signal?: AbortSignal,
): Promise<EmbeddingResult & { _routeInfo?: EmbeddingRouteInfo }> {
  const plan = await config.plannerClient.getPlan({
    model: modelId,
    capability: "embeddings",
    streaming: false,
  });

  const router = new RequestRouter({
    cloudEndpoint: config.serverUrl,
    apiKey: config.apiKey,
  });

  const decision = router.resolve({
    model: modelId,
    capability: "embeddings",
    streaming: false,
    plannerResult: plan ?? undefined,
  });

  // Embeddings are cloud-only in the Node SDK
  const result = await embed(config, modelId, input, signal);

  return Object.assign(result, {
    _routeInfo: {
      routeMetadata: decision.routeMetadata,
      routeEvent: decision.routeMetadata.routeEvent,
    },
  });
}
