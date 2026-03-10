import { describe, it, expect, vi, beforeEach } from "vitest";
import { InferenceEngine } from "../src/inference-engine.js";

// Mock onnxruntime-node
const mockRun = vi.fn();
const mockSessionCreate = vi.fn();
const MockTensor = vi.fn();

vi.mock("onnxruntime-node", () => ({
  InferenceSession: {
    create: (...args: any[]) => mockSessionCreate(...args),
  },
  Tensor: MockTensor,
}));

describe("InferenceEngine", () => {
  let engine: InferenceEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new InferenceEngine();

    mockSessionCreate.mockResolvedValue({
      inputNames: ["input"],
      outputNames: ["output"],
      run: mockRun,
    });

    MockTensor.mockImplementation((_type: string, data: any, dims: any) => ({
      type: _type,
      data,
      dims,
    }));
  });

  describe("createSession", () => {
    it("should create a session with default options", async () => {
      const result = await engine.createSession("/path/model.onnx");

      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/path/model.onnx",
        expect.objectContaining({
          graphOptimizationLevel: "all",
          executionProviders: ["cpu"],
        }),
      );
      expect(result.inputNames).toEqual(["input"]);
      expect(result.outputNames).toEqual(["output"]);
      expect(result.activeProvider).toBe("cpu");
    });

    it("should pass thread options", async () => {
      await engine.createSession("/path/model.onnx", {
        interOpNumThreads: 2,
        intraOpNumThreads: 4,
      });

      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/path/model.onnx",
        expect.objectContaining({
          interOpNumThreads: 2,
          intraOpNumThreads: 4,
        }),
      );
    });

    it("should use cuda provider with fallback chain", async () => {
      await engine.createSession("/path/model.onnx", {
        executionProvider: "cuda",
      });

      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/path/model.onnx",
        expect.objectContaining({
          executionProviders: ["cuda", "cpu"],
        }),
      );
    });

    it("should use tensorrt provider with fallback chain", async () => {
      await engine.createSession("/path/model.onnx", {
        executionProvider: "tensorrt",
      });

      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/path/model.onnx",
        expect.objectContaining({
          executionProviders: ["tensorrt", "cuda", "cpu"],
        }),
      );
    });

    it("should use coreml provider with fallback chain", async () => {
      await engine.createSession("/path/model.onnx", {
        executionProvider: "coreml",
      });

      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/path/model.onnx",
        expect.objectContaining({
          executionProviders: ["coreml", "cpu"],
        }),
      );
    });

    it("should fallback to CPU when provider fails", async () => {
      mockSessionCreate
        .mockRejectedValueOnce(new Error("CUDA not available"))
        .mockResolvedValueOnce({
          inputNames: ["input"],
          outputNames: ["output"],
          run: mockRun,
        });

      const result = await engine.createSession("/path/model.onnx", {
        executionProvider: "cuda",
      });

      expect(result.activeProvider).toBe("cpu");
      expect(mockSessionCreate).toHaveBeenCalledTimes(2);
    });

    it("should throw MODEL_LOAD_FAILED when CPU fallback also fails", async () => {
      mockSessionCreate
        .mockRejectedValueOnce(new Error("CUDA not available"))
        .mockRejectedValueOnce(new Error("CPU load failed"));

      await expect(
        engine.createSession("/path/model.onnx", { executionProvider: "cuda" }),
      ).rejects.toThrow("Failed to load model");
    });

    it("should throw MODEL_LOAD_FAILED when CPU provider fails directly", async () => {
      mockSessionCreate.mockRejectedValue(new Error("load error"));

      await expect(
        engine.createSession("/path/model.onnx"),
      ).rejects.toThrow("Failed to load model");
    });

    it("should pass custom graphOptimizationLevel", async () => {
      await engine.createSession("/path/model.onnx", {
        graphOptimizationLevel: "basic",
      });

      expect(mockSessionCreate).toHaveBeenCalledWith(
        "/path/model.onnx",
        expect.objectContaining({
          graphOptimizationLevel: "basic",
        }),
      );
    });
  });

  describe("run", () => {
    it("should run inference with NamedTensors input", async () => {
      const mockSession = {
        inputNames: ["input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Float32Array([0.1, 0.9]), dims: [1, 2] },
        }),
      };

      const result = await engine.run(mockSession, {
        input: { data: new Float32Array([1, 2, 3]), dims: [1, 3] },
      });

      expect(result.tensors.output).toBeDefined();
      expect(result.scores).toEqual([expect.closeTo(0.1), expect.closeTo(0.9)]);
      expect(result.label).toBe("1");
      expect(result.score).toBeCloseTo(0.9);
    });

    it("should run inference with text input", async () => {
      const mockSession = {
        inputNames: ["text_input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Float32Array([0.5]), dims: [1, 1] },
        }),
      };

      const result = await engine.run(mockSession, { text: "hello" });

      expect(MockTensor).toHaveBeenCalledWith(
        "int32",
        expect.any(Int32Array),
        [1, 5],
      );
      expect(result.tensors.output).toBeDefined();
    });

    it("should run inference with raw input", async () => {
      const mockSession = {
        inputNames: ["raw_input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Float32Array([0.7]), dims: [1, 1] },
        }),
      };

      const rawData = new Float32Array([1, 2, 3]);
      await engine.run(mockSession, { raw: rawData, dims: [1, 3] });

      expect(MockTensor).toHaveBeenCalledWith("float32", rawData, [1, 3]);
    });

    it("should infer tensor type for Int32Array", async () => {
      const mockSession = {
        inputNames: ["input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Int32Array([1]), dims: [1] },
        }),
      };

      await engine.run(mockSession, {
        input: { data: new Int32Array([1, 2]), dims: [1, 2] },
      });

      expect(MockTensor).toHaveBeenCalledWith("int32", expect.any(Int32Array), [1, 2]);
    });

    it("should infer tensor type for BigInt64Array", async () => {
      const mockSession = {
        inputNames: ["input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Int32Array([1]), dims: [1] },
        }),
      };

      await engine.run(mockSession, {
        input: { data: new BigInt64Array([1n, 2n]), dims: [1, 2] },
      });

      expect(MockTensor).toHaveBeenCalledWith("int64", expect.any(BigInt64Array), [1, 2]);
    });

    it("should infer tensor type for Uint8Array", async () => {
      const mockSession = {
        inputNames: ["input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Uint8Array([1]), dims: [1] },
        }),
      };

      await engine.run(mockSession, {
        input: { data: new Uint8Array([1, 2]), dims: [1, 2] },
      });

      expect(MockTensor).toHaveBeenCalledWith("uint8", expect.any(Uint8Array), [1, 2]);
    });

    it("should throw INFERENCE_FAILED on run error", async () => {
      const mockSession = {
        inputNames: ["input"],
        outputNames: ["output"],
        run: mockRun.mockRejectedValue(new Error("runtime error")),
      };

      await expect(
        engine.run(mockSession, {
          input: { data: new Float32Array([1]), dims: [1] },
        }),
      ).rejects.toThrow("Inference failed");
    });

    it("should not extract label/score for non-Float32Array output", async () => {
      const mockSession = {
        inputNames: ["input"],
        outputNames: ["output"],
        run: mockRun.mockResolvedValue({
          output: { data: new Int32Array([1, 2, 3]), dims: [1, 3] },
        }),
      };

      const result = await engine.run(mockSession, {
        input: { data: new Float32Array([1]), dims: [1] },
      });

      expect(result.label).toBeUndefined();
      expect(result.score).toBeUndefined();
      expect(result.scores).toBeUndefined();
    });
  });
});
