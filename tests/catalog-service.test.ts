import { describe, it, expect, vi } from "vitest";
import { ModelCatalogService } from "../src/manifest/catalog-service.js";
import { ModelReadinessManager } from "../src/manifest/readiness-manager.js";
import { ModelRef } from "../src/model-ref.js";
import { ModelCapability } from "../src/_generated/model_capability.js";
import { DeliveryMode } from "../src/_generated/delivery_mode.js";
import type { AppManifest, AppModelEntry } from "../src/manifest/types.js";
import type { ModelRuntime } from "../src/runtime/core/model-runtime.js";

function mockRuntime(): ModelRuntime {
  return {
    createSession: vi.fn(),
    run: vi.fn(),
    dispose: vi.fn(),
  };
}

describe("ModelCatalogService", () => {
  describe("bootstrap — bundled", () => {
    it("should register bundled model by capability and id", async () => {
      const entry: AppModelEntry = {
        id: "whisper-base",
        capability: ModelCapability.Transcription,
        delivery: DeliveryMode.Bundled,
        bundledPath: "/models/whisper-base.onnx",
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await service.bootstrap();

      expect(service.runtimeForCapability(ModelCapability.Transcription)).toBeDefined();
      expect(service.runtimeForRef(ModelRef.id("whisper-base"))).toBeDefined();
    });

    it("should throw if bundled entry has no bundledPath and is required", async () => {
      const entry: AppModelEntry = {
        id: "whisper-base",
        capability: ModelCapability.Transcription,
        delivery: DeliveryMode.Bundled,
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await expect(service.bootstrap()).rejects.toThrow("no bundledPath");
    });

    it("should skip optional bundled entry without bundledPath", async () => {
      const entry: AppModelEntry = {
        id: "whisper-base",
        capability: ModelCapability.Transcription,
        delivery: DeliveryMode.Bundled,
        required: false,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await expect(service.bootstrap()).resolves.not.toThrow();
      expect(service.runtimeForCapability(ModelCapability.Transcription)).toBeUndefined();
    });
  });

  describe("bootstrap — managed", () => {
    it("should enqueue managed entries in readiness manager", async () => {
      const entry: AppModelEntry = {
        id: "phi-4-mini",
        capability: ModelCapability.Chat,
        delivery: DeliveryMode.Managed,
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const enqueueSpy = vi.spyOn(readiness, "enqueue");
      const service = new ModelCatalogService({ manifest, readiness });

      await service.bootstrap();

      expect(enqueueSpy).toHaveBeenCalledWith(entry);
    });

    it("should resolve runtime when managed model becomes ready", async () => {
      const entry: AppModelEntry = {
        id: "phi-4-mini",
        capability: ModelCapability.Chat,
        delivery: DeliveryMode.Managed,
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await service.bootstrap();

      // Model not ready yet
      expect(service.runtimeForCapability(ModelCapability.Chat)).toBeUndefined();

      // Simulate readiness
      readiness._markReady("phi-4-mini", "/tmp/phi-4-mini.onnx");

      // Now should be resolved
      expect(service.runtimeForCapability(ModelCapability.Chat)).toBeDefined();
    });
  });

  describe("bootstrap — cloud", () => {
    it("should register cloud model via factory", async () => {
      const entry: AppModelEntry = {
        id: "gpt-4o",
        capability: ModelCapability.Chat,
        delivery: DeliveryMode.Cloud,
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const runtime = mockRuntime();
      const factory = vi.fn().mockReturnValue(runtime);
      const service = new ModelCatalogService({
        manifest,
        readiness,
        cloudRuntimeFactory: factory,
      });

      await service.bootstrap();

      expect(factory).toHaveBeenCalledWith("gpt-4o");
      expect(service.runtimeForCapability(ModelCapability.Chat)).toBe(runtime);
    });

    it("should throw if no cloud factory and entry is required", async () => {
      const entry: AppModelEntry = {
        id: "gpt-4o",
        capability: ModelCapability.Chat,
        delivery: DeliveryMode.Cloud,
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await expect(service.bootstrap()).rejects.toThrow("No cloud runtime factory");
    });
  });

  describe("runtimeForRef", () => {
    it("should resolve by id", async () => {
      const entry: AppModelEntry = {
        id: "whisper-base",
        capability: ModelCapability.Transcription,
        delivery: DeliveryMode.Bundled,
        bundledPath: "/models/whisper.onnx",
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await service.bootstrap();

      const runtime = service.runtimeForRef(ModelRef.id("whisper-base"));
      expect(runtime).toBeDefined();
    });

    it("should resolve by capability", async () => {
      const entry: AppModelEntry = {
        id: "whisper-base",
        capability: ModelCapability.Transcription,
        delivery: DeliveryMode.Bundled,
        bundledPath: "/models/whisper.onnx",
        required: true,
      };
      const manifest: AppManifest = { models: [entry] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await service.bootstrap();

      const runtime = service.runtimeForRef(
        ModelRef.capability(ModelCapability.Transcription),
      );
      expect(runtime).toBeDefined();
    });

    it("should return undefined for unknown ref", async () => {
      const manifest: AppManifest = { models: [] };
      const readiness = new ModelReadinessManager();
      const service = new ModelCatalogService({ manifest, readiness });

      await service.bootstrap();

      expect(service.runtimeForRef(ModelRef.id("unknown"))).toBeUndefined();
      expect(
        service.runtimeForRef(ModelRef.capability(ModelCapability.Embedding)),
      ).toBeUndefined();
    });
  });
});
