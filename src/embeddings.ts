/**
 * Cloud embeddings via POST /api/v1/embeddings.
 *
 * Calls the Octomil embeddings endpoint and returns dense vectors
 * suitable for semantic search, clustering, and RAG pipelines.
 */

import { OctomilError } from "./types.js";

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
      "serverUrl is required for embed()",
      "NETWORK_ERROR",
    );
  }
  if (!config.apiKey) {
    throw new OctomilError("apiKey is required for embed()", "NETWORK_ERROR");
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
      `embed() request failed: ${String(err)}`,
      "NETWORK_ERROR",
      err,
    );
  }

  if (!response.ok) {
    throw new OctomilError(
      `embed() failed: HTTP ${response.status}`,
      "INFERENCE_FAILED",
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
