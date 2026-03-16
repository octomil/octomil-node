/**
 * OctomilText — namespace for text prediction APIs on the client.
 *
 * Provides one-shot predict() and stateful predictor() factory.
 */

import type { ModelRef } from "../model-ref.js";
import { ModelRef as ModelRefFactory } from "../model-ref.js";
import { ModelCapability } from "../_generated/model_capability.js";
import type { ModelRuntime } from "../runtime/core/model-runtime.js";
import { OctomilPredictor } from "./octomil-predictor.js";
import { OctomilError } from "../types.js";

export type TextRuntimeResolver = (ref: ModelRef) => ModelRuntime | undefined;

export class OctomilText {
  private readonly runtimeResolver: TextRuntimeResolver;

  constructor(runtimeResolver: TextRuntimeResolver) {
    this.runtimeResolver = runtimeResolver;
  }

  /**
   * Generate text completion suggestions for the given prefix (one-shot).
   */
  async predict(
    prefix: string,
    options?: { model?: ModelRef; maxSuggestions?: number },
  ): Promise<string[]> {
    const model =
      options?.model ??
      ModelRefFactory.capability(ModelCapability.TextCompletion);
    const runtime = this.runtimeResolver(model);
    if (!runtime) {
      throw new OctomilError(
        "RUNTIME_UNAVAILABLE",
        "No runtime for text prediction model",
      );
    }

    const result = await runtime.run({
      prompt: prefix,
      maxTokens: 32,
      temperature: 0.3,
    });

    const text = typeof result["text"] === "string" ? result["text"] : "";
    const suggestions = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const max = options?.maxSuggestions ?? 3;
    return suggestions.slice(0, max);
  }

  /**
   * Create a stateful predictor that keeps the model warm between calls.
   */
  predictor(
    options?: { model?: ModelRef; capability?: ModelCapability },
  ): OctomilPredictor | null {
    const ref =
      options?.model ??
      ModelRefFactory.capability(
        options?.capability ?? ModelCapability.TextCompletion,
      );
    const runtime = this.runtimeResolver(ref);
    if (!runtime) return null;

    const id =
      ref.type === "id" ? ref.id : ref.capability;
    return new OctomilPredictor(runtime, id);
  }
}
