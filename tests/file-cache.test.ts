import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileCache } from "../src/file-cache.js";

// Mock node:fs
vi.mock("node:fs", () => {
  const store: Record<string, string> = {};
  const existingFiles = new Set<string>();

  return {
    existsSync: vi.fn((path: string) => {
      return path in store || existingFiles.has(path);
    }),
    readFileSync: vi.fn((path: string) => {
      if (path in store) return store[path];
      throw new Error("ENOENT");
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      store[path] = content;
    }),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    // Expose store for test manipulation
    __store: store,
    __existingFiles: existingFiles,
  };
});

describe("FileCache", () => {
  let cache: FileCache;
  let fsMock: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    fsMock = await import("node:fs");
    // Reset store
    for (const key of Object.keys(fsMock.__store)) {
      delete fsMock.__store[key];
    }
    fsMock.__existingFiles.clear();
    cache = new FileCache("/tmp/test-cache");
  });

  it("should return empty list when no manifest exists", () => {
    const list = cache.list();
    expect(list).toEqual([]);
  });

  it("should return false for has() when no manifest", () => {
    expect(cache.has("model:latest")).toBe(false);
  });

  it("should return null for getPath() when no manifest", () => {
    expect(cache.getPath("model:latest")).toBeNull();
  });

  it("should register and retrieve a cache entry", () => {
    fsMock.__existingFiles.add("/tmp/test-cache/model.onnx");

    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/model.onnx",
      checksum: "abc123",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 1024,
    });

    expect(cache.has("mymodel:v1")).toBe(true);
    expect(cache.getPath("mymodel:v1")).toBe("/tmp/test-cache/model.onnx");
  });

  it("should return false for has() if file doesn't exist on disk", () => {
    // Register entry but don't add file to existingFiles
    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/missing.onnx",
      checksum: "abc123",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 1024,
    });

    // The manifest file itself exists (was written), but the model file doesn't
    expect(cache.has("mymodel:v1")).toBe(false);
  });

  it("should return false for has() when checksum doesn't match", () => {
    fsMock.__existingFiles.add("/tmp/test-cache/model.onnx");

    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/model.onnx",
      checksum: "abc123",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 1024,
    });

    expect(cache.has("mymodel:v1", "different-checksum")).toBe(false);
  });

  it("should return true for has() when checksum matches", () => {
    fsMock.__existingFiles.add("/tmp/test-cache/model.onnx");

    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/model.onnx",
      checksum: "abc123",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 1024,
    });

    expect(cache.has("mymodel:v1", "abc123")).toBe(true);
  });

  it("should overwrite existing entry on re-register", () => {
    fsMock.__existingFiles.add("/tmp/test-cache/model-v2.onnx");

    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/model.onnx",
      checksum: "old",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 512,
    });

    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/model-v2.onnx",
      checksum: "new",
      cachedAt: "2024-02-01T00:00:00Z",
      sizeBytes: 1024,
    });

    expect(cache.getPath("mymodel:v1")).toBe("/tmp/test-cache/model-v2.onnx");
    expect(cache.has("mymodel:v1", "new")).toBe(true);
  });

  it("should remove a cached model", () => {
    fsMock.__existingFiles.add("/tmp/test-cache/model.onnx");

    cache.register({
      modelRef: "mymodel:v1",
      filePath: "/tmp/test-cache/model.onnx",
      checksum: "abc123",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 1024,
    });

    cache.remove("mymodel:v1");
    expect(fsMock.rmSync).toHaveBeenCalledWith("/tmp/test-cache/model.onnx");
    expect(cache.has("mymodel:v1")).toBe(false);
  });

  it("should handle remove when model not in manifest", () => {
    // Should not throw
    cache.remove("nonexistent:v1");
  });

  it("should list only entries with existing files", () => {
    fsMock.__existingFiles.add("/tmp/test-cache/model1.onnx");
    // model2.onnx intentionally not added

    cache.register({
      modelRef: "model1:v1",
      filePath: "/tmp/test-cache/model1.onnx",
      checksum: "a",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 100,
    });

    cache.register({
      modelRef: "model2:v1",
      filePath: "/tmp/test-cache/model2.onnx",
      checksum: "b",
      cachedAt: "2024-01-02T00:00:00Z",
      sizeBytes: 200,
    });

    const list = cache.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      modelRef: "model1:v1",
      filePath: "/tmp/test-cache/model1.onnx",
      cachedAt: "2024-01-01T00:00:00Z",
      sizeBytes: 100,
    });
  });

  it("should handle corrupt manifest gracefully", () => {
    fsMock.__store["/tmp/test-cache/manifest.json"] = "not json";
    expect(cache.has("model:v1")).toBe(false);
    expect(cache.list()).toEqual([]);
  });
});
