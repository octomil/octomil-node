/**
 * OctomilPredictor — stateful text predictor that keeps the model warm.
 *
 * Created via OctomilText.predictor(). Call close() when done to
 * release the underlying runtime resources.
 */

import type { ModelRuntime } from "../runtime/core/model-runtime.js";
import { OctomilError } from "../types.js";

export class OctomilPredictor {
  private readonly runtime: ModelRuntime;
  readonly modelId: string;
  private closed = false;

  constructor(runtime: ModelRuntime, modelId: string) {
    this.runtime = runtime;
    this.modelId = modelId;
  }

  /**
   * Generate text completions for the given prefix.
   */
  async predict(prefix: string, maxSuggestions = 3): Promise<string[]> {
    if (this.closed) {
      throw new OctomilError("CANCELLED", "Predictor has been closed");
    }

    const result = await this.runtime.run({
      prompt: prefix,
      maxTokens: 32,
      temperature: 0.3,
    });

    const text = typeof result["text"] === "string" ? result["text"] : "";
    const suggestions = text
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    return suggestions.slice(0, maxSuggestions);
  }

  /** Release the warm model resources. */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.runtime.dispose();
    }
  }
}
