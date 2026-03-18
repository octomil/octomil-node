import { describe, it, expect, vi } from "vitest";
import { LocalFileModelRuntime } from "../src/runtime/engines/local-file-runtime.js";
import { ArtifactResourceKind } from "../src/_generated/artifact_resource_kind.js";
import type { ModelRuntime } from "../src/runtime/core/model-runtime.js";
import type { ResourceBindings } from "../src/manifest/types.js";

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

  // ---------------------------------------------------------------------------
  // Resource bindings
  // ---------------------------------------------------------------------------

  describe("resource bindings", () => {
    it("should auto-populate weights binding from filePath when no bindings given", () => {
      const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.gguf");
      expect(rt.resourceBindings[ArtifactResourceKind.Weights]).toBe("/tmp/model.gguf");
    });

    it("should accept explicit resource bindings", () => {
      const bindings: ResourceBindings = {
        [ArtifactResourceKind.Weights]: "/cache/weights.gguf",
        [ArtifactResourceKind.Projector]: "/cache/mmproj.gguf",
      };
      const rt = new LocalFileModelRuntime("llava-7b", "/cache/weights.gguf", bindings);

      expect(rt.resourceBindings[ArtifactResourceKind.Weights]).toBe("/cache/weights.gguf");
      expect(rt.resourceBindings[ArtifactResourceKind.Projector]).toBe("/cache/mmproj.gguf");
    });

    it("getResource should return path for present resource", () => {
      const bindings: ResourceBindings = {
        [ArtifactResourceKind.Weights]: "/cache/weights.gguf",
        [ArtifactResourceKind.Projector]: "/cache/mmproj.gguf",
      };
      const rt = new LocalFileModelRuntime("llava-7b", "/cache/weights.gguf", bindings);

      expect(rt.getResource(ArtifactResourceKind.Weights)).toBe("/cache/weights.gguf");
      expect(rt.getResource(ArtifactResourceKind.Projector)).toBe("/cache/mmproj.gguf");
    });

    it("getResource should return undefined for absent resource", () => {
      const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.gguf");
      expect(rt.getResource(ArtifactResourceKind.Projector)).toBeUndefined();
    });

    it("requireResource should return path for present resource", () => {
      const bindings: ResourceBindings = {
        [ArtifactResourceKind.Weights]: "/cache/weights.gguf",
      };
      const rt = new LocalFileModelRuntime("phi-4-mini", "/cache/weights.gguf", bindings);
      expect(rt.requireResource(ArtifactResourceKind.Weights)).toBe("/cache/weights.gguf");
    });

    it("requireResource should throw for absent resource", () => {
      const rt = new LocalFileModelRuntime("phi-4-mini", "/tmp/model.gguf");
      expect(() => rt.requireResource(ArtifactResourceKind.Projector)).toThrow(
        "missing required resource: projector",
      );
    });

    it("hasResource should return true/false correctly", () => {
      const bindings: ResourceBindings = {
        [ArtifactResourceKind.Weights]: "/cache/weights.gguf",
        [ArtifactResourceKind.Projector]: "/cache/mmproj.gguf",
      };
      const rt = new LocalFileModelRuntime("llava-7b", "/cache/weights.gguf", bindings);

      expect(rt.hasResource(ArtifactResourceKind.Weights)).toBe(true);
      expect(rt.hasResource(ArtifactResourceKind.Projector)).toBe(true);
      expect(rt.hasResource(ArtifactResourceKind.Adapter)).toBe(false);
      expect(rt.hasResource(ArtifactResourceKind.Tokenizer)).toBe(false);
    });
  });
});
