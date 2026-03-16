import { describe, it, expect, vi } from "vitest";
import { LocalFileModelRuntime } from "../src/runtime/engines/local-file-runtime.js";
import type { ModelRuntime } from "../src/runtime/core/model-runtime.js";

describe("LocalFileModelRuntime", () => {
  it("should store modelId and filePath", () => {
    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    expect(rt.modelId).toBe("phi-4-mini");
    expect(rt.filePath).toBe("/tmp/model.onnx");
  });

  it("should throw on run without delegate", async () => {
    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    await expect(rt.run({ prompt: "hello" })).rejects.toThrow("no delegate engine set");
  });

  it("should delegate run to injected runtime", async () => {
    const delegate: ModelRuntime = {
      createSession: vi.fn(),
      run: vi.fn().mockResolvedValue({ text: "world" }),
      dispose: vi.fn(),
    };

    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    rt.setDelegate(delegate);

    const result = await rt.run({ prompt: "hello" });
    expect(result).toEqual({ text: "world" });
    expect(delegate.run).toHaveBeenCalledWith({ prompt: "hello" });
  });

  it("should delegate createSession to injected runtime", async () => {
    const delegate: ModelRuntime = {
      createSession: vi.fn(),
      run: vi.fn(),
      dispose: vi.fn(),
    };

    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    rt.setDelegate(delegate);

    await rt.createSession("/tmp/model.onnx", { graphOpt: "all" });
    expect(delegate.createSession).toHaveBeenCalledWith("/tmp/model.onnx", { graphOpt: "all" });
  });

  it("should not throw on createSession without delegate", async () => {
    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    await expect(rt.createSession("/tmp/model.onnx")).resolves.not.toThrow();
  });

  it("should dispose delegate on dispose", () => {
    const delegate: ModelRuntime = {
      createSession: vi.fn(),
      run: vi.fn(),
      dispose: vi.fn(),
    };

    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    rt.setDelegate(delegate);
    rt.dispose();

    expect(delegate.dispose).toHaveBeenCalled();
  });

  it("should throw on run after dispose", async () => {
    const delegate: ModelRuntime = {
      createSession: vi.fn(),
      run: vi.fn(),
      dispose: vi.fn(),
    };

    const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.onnx");
    rt.setDelegate(delegate);
    rt.dispose();

    // After dispose, delegate is null so it should throw
    await expect(rt.run({ prompt: "hello" })).rejects.toThrow("no delegate engine set");
  });
});
