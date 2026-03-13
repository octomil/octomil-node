import { describe, it, expect, vi, beforeEach } from "vitest";
import { Model } from "../src/model.js";
import type { InferenceEngine, SessionResult } from "../src/runtime/engines/onnx/engine.js";
import type { TelemetryReporter } from "../src/telemetry.js";
import { OctomilError } from "../src/types.js";

describe("Model", () => {
  let mockEngine: InferenceEngine;
  let mockTelemetry: TelemetryReporter;
  let model: Model;

  const mockSessionResult: SessionResult = {
    session: { id: "mock-session" },
    inputNames: ["input"],
    outputNames: ["output"],
    activeProvider: "cpu",
  };

  const mockRunResult = {
    tensors: {
      output: { data: new Float32Array([0.1, 0.9]), dims: [1, 2] },
    },
    label: "1",
    score: 0.9,
    scores: [0.1, 0.9],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEngine = {
      createSession: vi.fn().mockResolvedValue(mockSessionResult),
      run: vi.fn().mockResolvedValue(mockRunResult),
    } as unknown as InferenceEngine;

    mockTelemetry = {
      track: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
    } as unknown as TelemetryReporter;

    model = new Model("test-model:v1", "/path/model.onnx", mockEngine, mockTelemetry);
  });

  it("should not be loaded initially", () => {
    expect(model.isLoaded).toBe(false);
    expect(model.activeProvider).toBe("");
    expect(model.inputNames).toEqual([]);
    expect(model.outputNames).toEqual([]);
  });

  it("should load a model session", async () => {
    await model.load();

    expect(model.isLoaded).toBe(true);
    expect(model.activeProvider).toBe("cpu");
    expect(model.inputNames).toEqual(["input"]);
    expect(model.outputNames).toEqual(["output"]);
    expect(mockEngine.createSession).toHaveBeenCalledWith("/path/model.onnx", undefined);
    expect(mockTelemetry.track).toHaveBeenCalledWith("model_load", expect.objectContaining({
      "model.id": "test-model:v1",
      "inference.provider": "cpu",
    }));
  });

  it("should pass load options to engine", async () => {
    const options = { executionProvider: "cuda" as const, intraOpNumThreads: 4 };
    await model.load(options);
    expect(mockEngine.createSession).toHaveBeenCalledWith("/path/model.onnx", options);
  });

  it("should return this from load for chaining", async () => {
    const result = await model.load();
    expect(result).toBe(model);
  });

  it("should predict with loaded model", async () => {
    await model.load();
    const input = { raw: new Float32Array([1, 2, 3]), dims: [1, 3] };
    const result = await model.predict(input);

    expect(result.tensors).toBeDefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockEngine.run).toHaveBeenCalledWith(mockSessionResult.session, input);
    expect(mockTelemetry.track).toHaveBeenCalledWith("inference", expect.objectContaining({
      "model.id": "test-model:v1",
      "inference.modality": "tensor",
    }));
  });

  it("should throw MODEL_LOAD_FAILED when predicting without load", async () => {
    await expect(
      model.predict({ raw: new Float32Array([1]), dims: [1] }),
    ).rejects.toThrow(OctomilError);

    try {
      await model.predict({ raw: new Float32Array([1]), dims: [1] });
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("MODEL_LOAD_FAILED");
    }
  });

  it("should throw CANCELLED when loading after dispose", async () => {
    model.dispose();

    await expect(model.load()).rejects.toThrow(OctomilError);

    try {
      await model.load();
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("CANCELLED");
    }
  });

  it("should throw CANCELLED when predicting after dispose", async () => {
    await model.load();
    model.dispose();

    await expect(
      model.predict({ raw: new Float32Array([1]), dims: [1] }),
    ).rejects.toThrow(OctomilError);
  });

  it("should predictBatch sequentially", async () => {
    await model.load();
    const inputs = [
      { raw: new Float32Array([1]), dims: [1] },
      { raw: new Float32Array([2]), dims: [1] },
    ];
    const results = await model.predictBatch(inputs);

    expect(results).toHaveLength(2);
    expect(mockEngine.run).toHaveBeenCalledTimes(2);
  });

  it("should clear state on dispose", async () => {
    await model.load();
    expect(model.isLoaded).toBe(true);

    model.dispose();
    expect(model.isLoaded).toBe(false);
    expect(model.inputNames).toEqual([]);
    expect(model.outputNames).toEqual([]);
  });

  it("should work without telemetry", async () => {
    const modelNoTelemetry = new Model("test:v1", "/path/model.onnx", mockEngine, null);
    await modelNoTelemetry.load();
    const result = await modelNoTelemetry.predict({ raw: new Float32Array([1]), dims: [1] });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  describe("version and format", () => {
    it("should default to empty strings", () => {
      expect(model.version).toBe("");
      expect(model.format).toBe("");
    });

    it("should accept version and format in constructor", () => {
      const m = new Model("test:v2", "/path/model.onnx", mockEngine, null, undefined, "v2", "tflite");
      expect(m.version).toBe("v2");
      expect(m.format).toBe("tflite");
    });
  });

  describe("close", () => {
    it("should clear state like dispose", async () => {
      await model.load();
      expect(model.isLoaded).toBe(true);

      model.close();
      expect(model.isLoaded).toBe(false);
      expect(model.inputNames).toEqual([]);
      expect(model.outputNames).toEqual([]);
    });

    it("dispose should delegate to close", async () => {
      await model.load();
      const closeSpy = vi.spyOn(model, "close");
      model.dispose();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("predictStream", () => {
    it("should yield a single PredictOutput", async () => {
      await model.load();
      const results: unknown[] = [];
      for await (const output of model.predictStream({ raw: new Float32Array([1]), dims: [1] })) {
        results.push(output);
      }
      expect(results).toHaveLength(1);
      expect((results[0] as any).latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("should throw NOT_LOADED when model is not loaded", async () => {
      const gen = model.predictStream({ raw: new Float32Array([1]), dims: [1] });
      await expect(gen.next()).rejects.toThrow(OctomilError);
    });
  });

  describe("warmup", () => {
    it("should run dummy inference and track telemetry", async () => {
      await model.load();
      await model.warmup();

      // Engine.run should have been called with dummy input
      expect(mockEngine.run).toHaveBeenCalledTimes(1);
      expect(mockTelemetry.track).toHaveBeenCalledWith("model_warmup", {
        "model.id": "test-model:v1",
      });
    });

    it("should not throw if dummy inference fails", async () => {
      (mockEngine.run as any).mockRejectedValue(new Error("shape mismatch"));
      await model.load();
      await expect(model.warmup()).resolves.not.toThrow();
    });

    it("should throw NOT_LOADED when model is not loaded", async () => {
      await expect(model.warmup()).rejects.toThrow(OctomilError);
    });

    it("should throw SESSION_DISPOSED when model is disposed", async () => {
      await model.load();
      model.dispose();
      await expect(model.warmup()).rejects.toThrow(OctomilError);
    });
  });
});
