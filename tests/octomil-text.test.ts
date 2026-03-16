import { describe, it, expect, vi } from "vitest";
import { OctomilText } from "../src/text/octomil-text.js";
import { OctomilPredictor } from "../src/text/octomil-predictor.js";
import { ModelRef } from "../src/model-ref.js";
import { ModelCapability } from "../src/_generated/model_capability.js";
import type { ModelRuntime } from "../src/runtime/core/model-runtime.js";
import { OctomilError } from "../src/types.js";

function mockRuntime(text = "suggestion1\nsuggestion2\nsuggestion3"): ModelRuntime {
  return {
    createSession: vi.fn(),
    run: vi.fn().mockResolvedValue({ text }),
    dispose: vi.fn(),
  };
}

describe("OctomilText", () => {
  describe("predict", () => {
    it("should return text completions using default model", async () => {
      const runtime = mockRuntime();
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);

      const suggestions = await text.predict("The quick brown");

      expect(suggestions).toEqual(["suggestion1", "suggestion2", "suggestion3"]);
      expect(resolver).toHaveBeenCalledWith(
        ModelRef.capability(ModelCapability.TextCompletion),
      );
    });

    it("should respect maxSuggestions", async () => {
      const runtime = mockRuntime("a\nb\nc\nd\ne");
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);

      const suggestions = await text.predict("hello", { maxSuggestions: 2 });
      expect(suggestions).toHaveLength(2);
    });

    it("should use custom model ref", async () => {
      const runtime = mockRuntime("custom");
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);
      const ref = ModelRef.id("gpt-mini");

      await text.predict("hello", { model: ref });
      expect(resolver).toHaveBeenCalledWith(ref);
    });

    it("should throw when no runtime available", async () => {
      const resolver = vi.fn().mockReturnValue(undefined);
      const text = new OctomilText(resolver);

      await expect(text.predict("hello")).rejects.toThrow(OctomilError);
    });

    it("should filter empty lines", async () => {
      const runtime = mockRuntime("a\n\n\nb\n");
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);

      const suggestions = await text.predict("hello");
      expect(suggestions).toEqual(["a", "b"]);
    });
  });

  describe("predictor", () => {
    it("should create a stateful predictor", () => {
      const runtime = mockRuntime();
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);

      const predictor = text.predictor();
      expect(predictor).toBeInstanceOf(OctomilPredictor);
    });

    it("should return null when no runtime available", () => {
      const resolver = vi.fn().mockReturnValue(undefined);
      const text = new OctomilText(resolver);

      expect(text.predictor()).toBeNull();
    });

    it("should use custom capability", () => {
      const runtime = mockRuntime();
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);

      text.predictor({ capability: ModelCapability.KeyboardPrediction });
      expect(resolver).toHaveBeenCalledWith(
        ModelRef.capability(ModelCapability.KeyboardPrediction),
      );
    });

    it("should use custom model ref", () => {
      const runtime = mockRuntime();
      const resolver = vi.fn().mockReturnValue(runtime);
      const text = new OctomilText(resolver);
      const ref = ModelRef.id("custom-model");

      const predictor = text.predictor({ model: ref });
      expect(predictor).toBeInstanceOf(OctomilPredictor);
      expect(predictor!.modelId).toBe("custom-model");
    });
  });
});

describe("OctomilPredictor", () => {
  it("should predict text completions", async () => {
    const runtime = mockRuntime("prediction1\nprediction2");
    const predictor = new OctomilPredictor(runtime, "test-model");

    const result = await predictor.predict("The quick");
    expect(result).toEqual(["prediction1", "prediction2"]);
  });

  it("should respect maxSuggestions", async () => {
    const runtime = mockRuntime("a\nb\nc\nd");
    const predictor = new OctomilPredictor(runtime, "test-model");

    const result = await predictor.predict("hello", 2);
    expect(result).toHaveLength(2);
  });

  it("should throw after close", async () => {
    const runtime = mockRuntime();
    const predictor = new OctomilPredictor(runtime, "test-model");

    predictor.close();
    await expect(predictor.predict("hello")).rejects.toThrow("closed");
  });

  it("should dispose runtime on close", () => {
    const runtime = mockRuntime();
    const predictor = new OctomilPredictor(runtime, "test-model");

    predictor.close();
    expect(runtime.dispose).toHaveBeenCalled();
  });

  it("should only dispose once on double close", () => {
    const runtime = mockRuntime();
    const predictor = new OctomilPredictor(runtime, "test-model");

    predictor.close();
    predictor.close();
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });
});
