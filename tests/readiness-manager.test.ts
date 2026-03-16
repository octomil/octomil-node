import { describe, it, expect, vi } from "vitest";
import { ModelReadinessManager } from "../src/manifest/readiness-manager.js";
import { ModelCapability } from "../src/_generated/model_capability.js";
import { DeliveryMode } from "../src/_generated/delivery_mode.js";
import type { AppModelEntry } from "../src/manifest/types.js";

const managedEntry: AppModelEntry = {
  id: "phi-4-mini",
  capability: ModelCapability.Chat,
  delivery: DeliveryMode.Managed,
  required: true,
};

const bundledEntry: AppModelEntry = {
  id: "whisper-base",
  capability: ModelCapability.Transcription,
  delivery: DeliveryMode.Bundled,
  bundledPath: "models/whisper.onnx",
  required: true,
};

describe("ModelReadinessManager", () => {
  describe("enqueue", () => {
    it("should accept managed entries", () => {
      const mgr = new ModelReadinessManager();
      mgr.enqueue(managedEntry);
      expect(mgr.getEntry("phi-4-mini")).toBe(managedEntry);
    });

    it("should ignore non-managed entries", () => {
      const mgr = new ModelReadinessManager();
      mgr.enqueue(bundledEntry);
      expect(mgr.getEntry("whisper-base")).toBeUndefined();
    });
  });

  describe("isReady", () => {
    it("should return false for unknown models", () => {
      const mgr = new ModelReadinessManager();
      expect(mgr.isReady("unknown")).toBe(false);
    });

    it("should return true after markReady", () => {
      const mgr = new ModelReadinessManager();
      mgr._markReady("phi-4-mini", "/tmp/model.onnx");
      expect(mgr.isReady("phi-4-mini")).toBe(true);
    });
  });

  describe("awaitReady", () => {
    it("should resolve immediately if already ready", async () => {
      const mgr = new ModelReadinessManager();
      mgr._markReady("phi-4-mini", "/tmp/model.onnx");

      const path = await mgr.awaitReady("phi-4-mini");
      expect(path).toBe("/tmp/model.onnx");
    });

    it("should wait and resolve when model becomes ready", async () => {
      const mgr = new ModelReadinessManager();
      const promise = mgr.awaitReady("phi-4-mini");

      // Simulate async ready
      setTimeout(() => mgr._markReady("phi-4-mini", "/tmp/model.onnx"), 10);

      const path = await promise;
      expect(path).toBe("/tmp/model.onnx");
    });

    it("should reject when model fails", async () => {
      const mgr = new ModelReadinessManager();
      const promise = mgr.awaitReady("phi-4-mini");

      setTimeout(() => mgr._markFailed("phi-4-mini", new Error("download failed")), 10);

      await expect(promise).rejects.toThrow("download failed");
    });

    it("should resolve multiple waiters", async () => {
      const mgr = new ModelReadinessManager();
      const p1 = mgr.awaitReady("phi-4-mini");
      const p2 = mgr.awaitReady("phi-4-mini");

      mgr._markReady("phi-4-mini", "/tmp/model.onnx");

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("/tmp/model.onnx");
      expect(r2).toBe("/tmp/model.onnx");
    });
  });

  describe("events", () => {
    it("should emit ready event", () => {
      const mgr = new ModelReadinessManager();
      const listener = vi.fn();
      mgr.onUpdate(listener);

      mgr._markReady("phi-4-mini", "/tmp/model.onnx");

      expect(listener).toHaveBeenCalledWith({
        type: "ready",
        modelId: "phi-4-mini",
        filePath: "/tmp/model.onnx",
      });
    });

    it("should emit progress event", () => {
      const mgr = new ModelReadinessManager();
      const listener = vi.fn();
      mgr.onUpdate(listener);

      mgr._reportProgress("phi-4-mini", 0.5);

      expect(listener).toHaveBeenCalledWith({
        type: "progress",
        modelId: "phi-4-mini",
        fraction: 0.5,
      });
    });

    it("should emit failed event", () => {
      const mgr = new ModelReadinessManager();
      const listener = vi.fn();
      mgr.onUpdate(listener);

      const error = new Error("download failed");
      mgr._markFailed("phi-4-mini", error);

      expect(listener).toHaveBeenCalledWith({
        type: "failed",
        modelId: "phi-4-mini",
        error,
      });
    });

    it("should support unsubscribe", () => {
      const mgr = new ModelReadinessManager();
      const listener = vi.fn();
      const unsub = mgr.onUpdate(listener);

      unsub();
      mgr._markReady("phi-4-mini", "/tmp/model.onnx");

      expect(listener).not.toHaveBeenCalled();
    });

    it("should not throw if listener throws", () => {
      const mgr = new ModelReadinessManager();
      mgr.onUpdate(() => {
        throw new Error("bad listener");
      });

      expect(() => mgr._markReady("phi-4-mini", "/tmp/model.onnx")).not.toThrow();
    });
  });
});
