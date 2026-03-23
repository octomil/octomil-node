import type {
  ResponseObj,
  ResponseRequest,
  ResponseStreamEvent,
} from "./responses.js";

/**
 * Pluggable local runtime for `responses.create()` / `responses.stream()`.
 *
 * Node SDK callers can inject a concrete local LLM runtime while the public
 * SDK surface remains stable at the responses layer.
 */
export interface LocalResponsesRuntime {
  create(request: ResponseRequest): Promise<ResponseObj>;
  stream(request: ResponseRequest): AsyncGenerator<ResponseStreamEvent>;
}

export type LocalResponsesRuntimeResolver = (
  model: string,
) => LocalResponsesRuntime | null | undefined;
