import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelsClient } from "../src/models.js";
import type { ModelStatus, PullAndLoadFn } from "../src/models.js";
import type { FileCache } from "../src/file-cache.js";
import type { Model } from "../src/model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCache(): FileCache {
  return {
    has: vi.fn().mockReturnValue(false),
    getPath: vi.fn().mockReturnValue(null),
    register: vi.fn(),
    remove: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  } as unknown as FileCache;
}

function createMockModel(ref: string): Model {
  return {
    modelRef: ref,
    filePath: `/tmp/${ref}/model.onnx`,
    isLoaded: true,
    dispose: vi.fn(),
    load: vi.fn(),
    predict: vi.fn(),
  } as unknown as Model;
}

function createClient(overrides?: {
  cache?: FileCache;
  loadedModels?: Map<string, Model>;
  activeDownloads?: Set<string>;
  errorModels?: Set<string>;
  pullAndLoad?: PullAndLoadFn;
}) {
  const cache = overrides?.cache ?? createMockCache();
  const loadedModels = overrides?.loadedModels ?? new Map<string, Model>();
  const activeDownloads = overrides?.activeDownloads ?? new Set<string>();
  const errorModels = overrides?.errorModels ?? new Set<string>();
  const pullAndLoad: PullAndLoadFn =
    overrides?.pullAndLoad ?? vi.fn().mockResolvedValue(createMockModel("test:latest"));

  const client = new ModelsClient({
    cache,
    loadedModels,
    activeDownloads,
    errorModels,
    pullAndLoad,
  });

  return { client, cache, loadedModels, activeDownloads, errorModels, pullAndLoad };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelsClient", () => {
  describe("status", () => {
    it("should return 'not_cached' when model is unknown", () => {
      const { client } = createClient();
      expect(client.status("unknown:v1")).toBe("not_cached");
    });

    it("should return 'ready' when model is cached on disk", () => {
      const cache = createMockCache();
      (cache.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const { client } = createClient({ cache });

      expect(client.status("mymodel:v1")).toBe("ready");
    });

    it("should return 'downloading' when model is being downloaded", () => {
      const activeDownloads = new Set(["mymodel:v1"]);
      const { client } = createClient({ activeDownloads });

      expect(client.status("mymodel:v1")).toBe("downloading");
    });

    it("should return 'error' when model download/load failed", () => {
      const errorModels = new Set(["mymodel:v1"]);
      const { client } = createClient({ errorModels });

      expect(client.status("mymodel:v1")).toBe("error");
    });

    it("should prioritize 'downloading' over 'ready'", () => {
      const cache = createMockCache();
      (cache.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const activeDownloads = new Set(["mymodel:v1"]);
      const { client } = createClient({ cache, activeDownloads });

      expect(client.status("mymodel:v1")).toBe("downloading");
    });

    it("should prioritize 'downloading' over 'error'", () => {
      const activeDownloads = new Set(["mymodel:v1"]);
      const errorModels = new Set(["mymodel:v1"]);
      const { client } = createClient({ activeDownloads, errorModels });

      expect(client.status("mymodel:v1")).toBe("downloading");
    });

    it("should prioritize 'error' over 'ready'", () => {
      const cache = createMockCache();
      (cache.has as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const errorModels = new Set(["mymodel:v1"]);
      const { client } = createClient({ cache, errorModels });

      expect(client.status("mymodel:v1")).toBe("error");
    });
  });

  describe("load", () => {
    it("should pull and load a model successfully", async () => {
      const mockModel = createMockModel("test:latest");
      const pullAndLoad = vi.fn().mockResolvedValue(mockModel);
      const { client, loadedModels } = createClient({ pullAndLoad });

      const result = await client.load("test:latest");

      expect(result).toBe(mockModel);
      expect(pullAndLoad).toHaveBeenCalledWith("test:latest", undefined);
      expect(loadedModels.get("test:latest")).toBe(mockModel);
    });

    it("should pass version option through", async () => {
      const mockModel = createMockModel("test:v2");
      const pullAndLoad = vi.fn().mockResolvedValue(mockModel);
      const { client } = createClient({ pullAndLoad });

      await client.load("test:v2", { version: "v2" });

      expect(pullAndLoad).toHaveBeenCalledWith("test:v2", { version: "v2" });
    });

    it("should set downloading status during load", async () => {
      let resolveLoad: (m: Model) => void;
      const loadPromise = new Promise<Model>((resolve) => {
        resolveLoad = resolve;
      });
      const pullAndLoad = vi.fn().mockReturnValue(loadPromise);
      const { client } = createClient({ pullAndLoad });

      const loadResult = client.load("test:latest");

      // While loading, status should be "downloading"
      expect(client.status("test:latest")).toBe("downloading");

      // Resolve the load
      resolveLoad!(createMockModel("test:latest"));
      await loadResult;

      // After loading, status depends on cache (not downloading anymore)
      expect(client.status("test:latest")).not.toBe("downloading");
    });

    it("should set error status on failure", async () => {
      const pullAndLoad = vi.fn().mockRejectedValue(new Error("download failed"));
      const { client } = createClient({ pullAndLoad });

      await expect(client.load("test:latest")).rejects.toThrow("download failed");
      expect(client.status("test:latest")).toBe("error");
    });

    it("should clear error status on retry", async () => {
      const errorModels = new Set(["test:latest"]);
      const mockModel = createMockModel("test:latest");
      const pullAndLoad = vi.fn().mockResolvedValue(mockModel);
      const { client } = createClient({ errorModels, pullAndLoad });

      expect(client.status("test:latest")).toBe("error");
      await client.load("test:latest");
      expect(client.status("test:latest")).not.toBe("error");
    });
  });

  describe("unload", () => {
    it("should dispose and remove a loaded model", () => {
      const mockModel = createMockModel("test:latest");
      const loadedModels = new Map<string, Model>([["test:latest", mockModel]]);
      const { client } = createClient({ loadedModels });

      client.unload("test:latest");

      expect(mockModel.dispose).toHaveBeenCalled();
      expect(loadedModels.has("test:latest")).toBe(false);
    });

    it("should be a no-op when model is not loaded", () => {
      const { client } = createClient();
      // Should not throw
      client.unload("nonexistent:v1");
    });
  });

  describe("list", () => {
    it("should return empty array when no models cached", () => {
      const { client } = createClient();
      expect(client.list()).toEqual([]);
    });

    it("should return cached model info from FileCache", () => {
      const cache = createMockCache();
      (cache.list as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          modelRef: "model1:v1",
          filePath: "/tmp/model1.onnx",
          cachedAt: "2024-01-01T00:00:00Z",
          sizeBytes: 1024,
        },
        {
          modelRef: "model2:v2",
          filePath: "/tmp/model2.onnx",
          cachedAt: "2024-02-01T00:00:00Z",
          sizeBytes: 2048,
        },
      ]);
      const { client } = createClient({ cache });

      const list = client.list();

      expect(list).toHaveLength(2);
      expect(list[0]).toEqual({
        modelRef: "model1:v1",
        filePath: "/tmp/model1.onnx",
        cachedAt: "2024-01-01T00:00:00Z",
        sizeBytes: 1024,
      });
      expect(list[1]).toEqual({
        modelRef: "model2:v2",
        filePath: "/tmp/model2.onnx",
        cachedAt: "2024-02-01T00:00:00Z",
        sizeBytes: 2048,
      });
    });
  });

  describe("clearCache", () => {
    it("should remove all cached models from disk and memory", () => {
      const cache = createMockCache();
      const mockModel = createMockModel("model1:v1");
      const loadedModels = new Map<string, Model>([["model1:v1", mockModel]]);

      (cache.list as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          modelRef: "model1:v1",
          filePath: "/tmp/model1.onnx",
          cachedAt: "2024-01-01T00:00:00Z",
          sizeBytes: 1024,
        },
        {
          modelRef: "model2:v1",
          filePath: "/tmp/model2.onnx",
          cachedAt: "2024-02-01T00:00:00Z",
          sizeBytes: 2048,
        },
      ]);

      const { client } = createClient({ cache, loadedModels });
      client.clearCache();

      // Should dispose loaded model
      expect(mockModel.dispose).toHaveBeenCalled();
      expect(loadedModels.has("model1:v1")).toBe(false);

      // Should remove both from disk cache
      expect(cache.remove).toHaveBeenCalledWith("model1:v1");
      expect(cache.remove).toHaveBeenCalledWith("model2:v1");
    });

    it("should handle empty cache gracefully", () => {
      const { client } = createClient();
      // Should not throw
      client.clearCache();
    });
  });
});
