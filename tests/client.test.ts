import { describe, it, expect, vi, beforeEach } from "vitest";
import { OctomilClient } from "../src/client.js";
import { OctomilError } from "../src/types.js";

// Mock all dependencies
vi.mock("../src/model-downloader.js", () => ({
  ModelDownloader: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({
      name: "test-model",
      tag: "latest",
      downloadUrl: "https://cdn.test.com/model.onnx",
      format: "onnx",
      sizeBytes: 2048,
      checksum: "sha256hash",
    }),
    download: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../src/file-cache.js", () => ({
  FileCache: vi.fn().mockImplementation(() => ({
    has: vi.fn().mockReturnValue(false),
    getPath: vi.fn().mockReturnValue(null),
    register: vi.fn(),
    remove: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock("../src/inference-engine.js", () => ({
  InferenceEngine: vi.fn().mockImplementation(() => ({
    createSession: vi.fn(),
    run: vi.fn(),
  })),
}));

vi.mock("../src/telemetry.js", () => ({
  TelemetryReporter: vi.fn().mockImplementation(() => ({
    track: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("../src/integrity.js", () => ({
  computeFileHash: vi.fn().mockResolvedValue("sha256hash"),
}));

describe("OctomilClient", () => {
  let client: OctomilClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new OctomilClient({
      apiKey: "test-key",
      orgId: "org-123",
      serverUrl: "https://api.test.com",
      cacheDir: "/tmp/test-cache",
    });
  });

  describe("pull", () => {
    it("should download and cache a model", async () => {
      const model = await client.pull("test-model:latest");

      expect(model).toBeDefined();
      expect(model.modelRef).toBe("test-model:latest");
    });

    it("should return cached model when available", async () => {
      const { FileCache } = await import("../src/file-cache.js");
      const mockCache = (FileCache as any).mock.results[0].value;
      mockCache.has.mockReturnValue(true);
      mockCache.getPath.mockReturnValue("/tmp/test-cache/test-model/latest/model.onnx");

      const model = await client.pull("test-model:latest");
      expect(model.filePath).toBe("/tmp/test-cache/test-model/latest/model.onnx");
    });

    it("should force download when force option is set", async () => {
      const { FileCache } = await import("../src/file-cache.js");
      const mockCache = (FileCache as any).mock.results[0].value;
      mockCache.has.mockReturnValue(true);

      const { ModelDownloader } = await import("../src/model-downloader.js");
      const mockDownloader = (ModelDownloader as any).mock.results[0].value;

      await client.pull("test-model:latest", { force: true });

      expect(mockDownloader.download).toHaveBeenCalled();
    });

    it("should throw INTEGRITY_ERROR on checksum mismatch", async () => {
      const { computeFileHash } = await import("../src/integrity.js");
      (computeFileHash as any).mockResolvedValue("wrong-hash");

      await expect(client.pull("test-model:latest")).rejects.toThrow(OctomilError);

      try {
        (computeFileHash as any).mockResolvedValue("wrong-hash");
        await client.pull("test-model:latest");
      } catch (err) {
        expect((err as OctomilError).code).toBe("INTEGRITY_ERROR");
      }
    });

    it("should skip integrity check when no checksum provided", async () => {
      const { ModelDownloader } = await import("../src/model-downloader.js");
      const mockDownloader = (ModelDownloader as any).mock.results[0].value;
      mockDownloader.resolve.mockResolvedValue({
        name: "test-model",
        tag: "latest",
        downloadUrl: "https://cdn.test.com/model.onnx",
        format: "onnx",
        sizeBytes: 2048,
        checksum: undefined,
      });

      const { computeFileHash } = await import("../src/integrity.js");
      const model = await client.pull("test-model:latest");
      expect(model).toBeDefined();
      expect(computeFileHash).not.toHaveBeenCalled();
    });
  });

  describe("listCached", () => {
    it("should return list from cache", async () => {
      const { FileCache } = await import("../src/file-cache.js");
      const mockCache = (FileCache as any).mock.results[0].value;
      mockCache.list.mockReturnValue([
        {
          modelRef: "m:v1",
          filePath: "/tmp/m.onnx",
          cachedAt: "2024-01-01",
          sizeBytes: 100,
        },
      ]);

      const list = await client.listCached();
      expect(list).toHaveLength(1);
      expect(list[0]!.modelRef).toBe("m:v1");
    });
  });

  describe("removeCache", () => {
    it("should delegate to cache.remove", async () => {
      const { FileCache } = await import("../src/file-cache.js");
      const mockCache = (FileCache as any).mock.results[0].value;

      await client.removeCache("test-model:v1");
      expect(mockCache.remove).toHaveBeenCalledWith("test-model:v1");
    });
  });

  describe("predict", () => {
    beforeEach(async () => {
      // Ensure integrity mock returns matching hash (may be dirty from earlier tests)
      const { computeFileHash } = await import("../src/integrity.js");
      (computeFileHash as any).mockResolvedValue("sha256hash");
    });

    it("should pull, load, and predict in one call", async () => {
      const sharedEngine = {
        createSession: vi.fn().mockResolvedValue({
          session: {},
          inputNames: ["input"],
          outputNames: ["output"],
          activeProvider: "cpu",
        }),
        run: vi.fn().mockResolvedValue({
          tensors: { output: { data: new Float32Array([0.1, 0.9]), dims: [1, 2] } },
          label: "1",
          score: 0.9,
          scores: [0.1, 0.9],
        }),
      };
      const { InferenceEngine } = await import("../src/inference-engine.js");
      (InferenceEngine as any).mockImplementation(() => sharedEngine);

      const result = await client.predict("test-model", { text: "hello" });
      expect(result.label).toBe("1");
      expect(result.score).toBe(0.9);
    });

    it("should cache model between predict calls", async () => {
      // Set up a shared mock engine that all new InferenceEngine instances use
      const sharedEngine = {
        createSession: vi.fn().mockResolvedValue({
          session: {},
          inputNames: ["input"],
          outputNames: ["output"],
          activeProvider: "cpu",
        }),
        run: vi.fn().mockResolvedValue({
          tensors: { output: { data: new Float32Array([0.5]), dims: [1] } },
        }),
      };
      const { InferenceEngine } = await import("../src/inference-engine.js");
      (InferenceEngine as any).mockImplementation(() => sharedEngine);

      await client.predict("test-model", { text: "a" });
      await client.predict("test-model", { text: "b" });

      // Model loaded once (cached), inference ran twice
      expect(sharedEngine.createSession).toHaveBeenCalledTimes(1);
      expect(sharedEngine.run).toHaveBeenCalledTimes(2);
    });
  });

  describe("dispose", () => {
    it("should dispose telemetry and cached models", async () => {
      const { TelemetryReporter } = await import("../src/telemetry.js");
      const mockTelemetry = (TelemetryReporter as any).mock.results[0].value;

      client.dispose();
      expect(mockTelemetry.dispose).toHaveBeenCalled();
    });

    it("should not throw when telemetry is disabled", () => {
      const clientNoTelemetry = new OctomilClient({
        apiKey: "test-key",
        orgId: "org-123",
        telemetry: false,
      });

      expect(() => clientNoTelemetry.dispose()).not.toThrow();
    });
  });
});
