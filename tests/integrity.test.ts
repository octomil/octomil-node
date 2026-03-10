import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeFileHash } from "../src/integrity.js";

// Mock node:fs and node:crypto
const mockUpdate = vi.fn();
const mockDigest = vi.fn().mockReturnValue("abc123def456");
const mockCreateHash = vi.fn().mockReturnValue({
  update: mockUpdate,
  digest: mockDigest,
});

let streamCallbacks: Record<string, (...args: any[]) => void> = {};
const mockStream = {
  on: vi.fn((event: string, cb: (...args: any[]) => void) => {
    streamCallbacks[event] = cb;
    return mockStream;
  }),
};
const mockCreateReadStream = vi.fn().mockReturnValue(mockStream);

vi.mock("node:fs", () => ({
  createReadStream: (...args: any[]) => mockCreateReadStream(...args),
}));

vi.mock("node:crypto", () => ({
  createHash: (...args: any[]) => mockCreateHash(...args),
}));

describe("computeFileHash", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamCallbacks = {};
    mockStream.on.mockImplementation((event: string, cb: (...args: any[]) => void) => {
      streamCallbacks[event] = cb;
      return mockStream;
    });
  });

  it("should compute sha256 hash of a file", async () => {
    const hashPromise = computeFileHash("/path/to/model.onnx");

    // Simulate data chunks
    streamCallbacks["data"]!(Buffer.from("chunk1"));
    streamCallbacks["data"]!(Buffer.from("chunk2"));
    streamCallbacks["end"]!();

    const result = await hashPromise;
    expect(result).toBe("abc123def456");
    expect(mockCreateHash).toHaveBeenCalledWith("sha256");
    expect(mockCreateReadStream).toHaveBeenCalledWith("/path/to/model.onnx");
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(mockDigest).toHaveBeenCalledWith("hex");
  });

  it("should reject on stream error", async () => {
    const hashPromise = computeFileHash("/path/to/bad-file");

    streamCallbacks["error"]!(new Error("read error"));

    await expect(hashPromise).rejects.toThrow("read error");
  });
});
