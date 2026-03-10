import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelDownloader } from "../src/model-downloader.js";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:fs
vi.mock("node:fs", () => ({
  createWriteStream: vi.fn().mockReturnValue({
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  }),
}));

// Mock node:stream/promises
vi.mock("node:stream/promises", () => ({
  pipeline: vi.fn().mockResolvedValue(undefined),
}));

// Mock node:stream
vi.mock("node:stream", () => ({
  Readable: {
    fromWeb: vi.fn().mockReturnValue({ pipe: vi.fn() }),
  },
  Transform: vi.fn().mockImplementation(() => ({
    _transform: vi.fn(),
  })),
}));

describe("ModelDownloader", () => {
  let downloader: ModelDownloader;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    downloader = new ModelDownloader("https://api.test.com", "test-key", "org-123");
  });

  describe("resolve", () => {
    it("should resolve a model reference", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "my-model",
          tag: "v1",
          download_url: "https://cdn.test.com/model.onnx",
          format: "onnx",
          size_bytes: 1024,
          checksum: "abc123",
        }),
      });

      const result = await downloader.resolve("my-model:v1");

      expect(result).toEqual({
        name: "my-model",
        tag: "v1",
        downloadUrl: "https://cdn.test.com/model.onnx",
        format: "onnx",
        sizeBytes: 1024,
        checksum: "abc123",
      });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.test.com/api/v1/registry/pull",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-key",
          }),
        }),
      );
    });

    it("should default tag to 'latest' when not specified", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "my-model",
          tag: "latest",
          download_url: "https://cdn.test.com/model.onnx",
        }),
      });

      await downloader.resolve("my-model");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tag).toBe("latest");
    });

    it("should use version override", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "my-model",
          tag: "v2",
          download_url: "https://cdn.test.com/model.onnx",
        }),
      });

      await downloader.resolve("my-model:v1", "v2");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tag).toBe("v2");
    });

    it("should use format override", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "my-model",
          download_url: "https://cdn.test.com/model.onnx",
        }),
      });

      await downloader.resolve("my-model:v1", undefined, "tflite");

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.format).toBe("tflite");
    });

    it("should throw MODEL_NOT_FOUND on non-ok response", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "not found",
      });

      await expect(downloader.resolve("missing:v1")).rejects.toThrow(
        "Registry resolve failed (404)",
      );
    });

    it("should handle missing fields with defaults", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({
          download_url: "https://cdn.test.com/model.onnx",
        }),
      });

      const result = await downloader.resolve("my-model:v1");
      expect(result.name).toBe("my-model");
      expect(result.tag).toBe("v1");
      expect(result.format).toBe("onnx");
      expect(result.sizeBytes).toBe(0);
    });
  });

  describe("download", () => {
    it("should download a file", async () => {
      const mockBody = { getReader: vi.fn() };
      fetchMock.mockResolvedValue({
        ok: true,
        body: mockBody,
        headers: new Map([["content-length", "1024"]]),
      });

      await downloader.download(
        "https://cdn.test.com/model.onnx",
        "/tmp/model.onnx",
      );

      expect(fetchMock).toHaveBeenCalledWith("https://cdn.test.com/model.onnx");
    });

    it("should throw NETWORK_ERROR on failed download", async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        body: null,
      });

      await expect(
        downloader.download("https://cdn.test.com/model.onnx", "/tmp/model.onnx"),
      ).rejects.toThrow("Download failed (500)");
    });

    it("should throw NETWORK_ERROR when body is null", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        body: null,
        status: 200,
      });

      await expect(
        downloader.download("https://cdn.test.com/model.onnx", "/tmp/model.onnx"),
      ).rejects.toThrow("Download failed");
    });
  });
});
