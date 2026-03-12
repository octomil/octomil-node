import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single token received from the cloud streaming inference endpoint. */
export interface StreamToken {
  token: string;
  done: boolean;
  provider?: string;
  latencyMs?: number;
  sessionId?: string;
}

/** Configuration for the streaming client. */
export interface StreamingConfig {
  serverUrl: string;
  apiKey: string;
}

/** Input for streaming inference — either a string prompt or chat messages. */
export type StreamInput =
  | string
  | { role: string; content: string }[];

// ---------------------------------------------------------------------------
// SSE Parsing
// ---------------------------------------------------------------------------

/** Parse a single SSE line into a StreamToken, or `null` if not a data event. */
export function parseSSELine(line: string): StreamToken | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;

  const dataStr = trimmed.slice(5).trim();
  if (!dataStr) return null;

  try {
    const parsed = JSON.parse(dataStr) as Record<string, unknown>;
    return {
      token: typeof parsed["token"] === "string" ? parsed["token"] : "",
      done: typeof parsed["done"] === "boolean" ? parsed["done"] : false,
      provider: typeof parsed["provider"] === "string" ? parsed["provider"] : undefined,
      latencyMs: typeof parsed["latency_ms"] === "number" ? parsed["latency_ms"] : undefined,
      sessionId: typeof parsed["session_id"] === "string" ? parsed["session_id"] : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

function buildPayload(
  modelId: string,
  input: StreamInput,
  parameters?: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { model_id: modelId };

  if (typeof input === "string") {
    payload["input_data"] = input;
  } else {
    payload["messages"] = input;
  }

  if (parameters && Object.keys(parameters).length > 0) {
    payload["parameters"] = parameters;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// streamInference
// ---------------------------------------------------------------------------

/**
 * Stream tokens from `POST /api/v1/inference/stream` via SSE.
 *
 * Returns an `AsyncGenerator` of {@link StreamToken} values.
 *
 * ```ts
 * for await (const tok of streamInference(cfg, "phi-4-mini", "Hello")) {
 *   process.stdout.write(tok.token);
 * }
 * ```
 */
export async function* streamInference(
  config: StreamingConfig,
  modelId: string,
  input: StreamInput,
  parameters?: Record<string, unknown>,
): AsyncGenerator<StreamToken> {
  const url = `${config.serverUrl.replace(/\/+$/, "")}/api/v1/inference/stream`;
  const body = JSON.stringify(buildPayload(modelId, input, parameters));

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "text/event-stream",
        "User-Agent": "octomil-node/1.0",
      },
      body,
    });
  } catch (err) {
    throw new OctomilError(
      `Cloud streaming request failed: ${String(err)}`,
      "NETWORK_UNAVAILABLE",
      err,
    );
  }

  if (!response.ok) {
    throw new OctomilError(
      `Cloud streaming inference failed: HTTP ${response.status}`,
      "INFERENCE_FAILED",
    );
  }

  if (!response.body) {
    throw new OctomilError(
      "Cloud streaming inference returned empty body",
      "INFERENCE_FAILED",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const token = parseSSELine(line);
        if (token) {
          yield token;
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      const token = parseSSELine(buffer);
      if (token) {
        yield token;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
