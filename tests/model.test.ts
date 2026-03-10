import { describe, it, expect, vi, beforeEach } from "vitest";
import { Model } from "../src/model.js";
import type { InferenceEngine, SessionResult } from "../src/inference-engine.js";
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

  it("should throw NOT_LOADED when predicting without load", async () => {
    await expect(
      model.predict({ raw: new Float32Array([1]), dims: [1] }),
    ).rejects.toThrow(OctomilError);

    try {
      await model.predict({ raw: new Float32Array([1]), dims: [1] });
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("NOT_LOADED");
    }
  });

  it("should throw SESSION_DISPOSED when loading after dispose", async () => {
    model.dispose();

    await expect(model.load()).rejects.toThrow(OctomilError);

    try {
      await model.load();
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      expect((err as OctomilError).code).toBe("SESSION_DISPOSED");
    }
  });

  it("should throw SESSION_DISPOSED when predicting after dispose", async () => {
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
});
