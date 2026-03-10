import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RoutingClient } from "../src/routing.js";
import type { RoutingDecision, DeviceCapabilities } from "../src/routing.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEVICE_CAPS: DeviceCapabilities = {
  platform: "node",
  model: "Linux x64 6.1",
  total_memory_mb: 8192,
  gpu_available: false,
  npu_available: false,
  supported_runtimes: ["onnxruntime-node"],
};

const CLOUD_DECISION: RoutingDecision = {
  id: "route-1",
  target: "cloud",
  format: "onnx",
  engine: "triton",
  fallback_target: null,
};

const DEVICE_DECISION: RoutingDecision = {
  id: "route-2",
  target: "device",
  format: "onnx",
  engine: "onnxruntime-node",
  fallback_target: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RoutingClient", () => {
  let client: RoutingClient;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octomil-routing-test-"));
    client = new RoutingClient({
      serverUrl: "https://api.octomil.com",
      apiKey: "test-key",
      cacheTtlMs: 5000,
      prefer: "fastest",
      cachePath: tmpDir,
    });
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // route() — normal behavior
  // -------------------------------------------------------------------------

  describe("route", () => {
    it("calls POST /api/v1/route and returns decision", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
      );

      const result = await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual(CLOUD_DECISION);
      expect(client.lastRouteWasOffline).toBe(false);
    });

    it("returns cached decision on second call within TTL", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );

      const first = await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      const second = await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(first).toEqual(DEVICE_DECISION);
      expect(second).toEqual(DEVICE_DECISION);
    });
  });

  // -------------------------------------------------------------------------
  // Offline fallback
  // -------------------------------------------------------------------------

  describe("offline fallback", () => {
    it("returns persistent-cached decision on network failure", async () => {
      // First call succeeds and persists.
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
      );
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      // Create a new client to clear in-memory cache.
      const client2 = new RoutingClient({
        serverUrl: "https://api.octomil.com",
        apiKey: "test-key",
        cacheTtlMs: 5000,
        cachePath: tmpDir,
      });

      // Second call fails — should get persistent cache.
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));
      const result = await client2.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(result.id).toBe("route-1");
      expect(result.target).toBe("cloud");
      expect(result.cached).toBe(true);
      expect(result.offline).toBe(false);
      expect(client2.lastRouteWasOffline).toBe(true);
    });

    it("returns synthetic device decision when no cache and network fails", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));

      const result = await client.route("model-x", 500, 2.0, DEVICE_CAPS);

      expect(result.id).toBe("offline-model-x");
      expect(result.target).toBe("device");
      expect(result.format).toBe("onnx");
      expect(result.engine).toBe("onnxruntime-node");
      expect(result.cached).toBe(false);
      expect(result.offline).toBe(true);
      expect(client.lastRouteWasOffline).toBe(true);
    });

    it("returns synthetic device decision on non-200 with no cache", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const result = await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      expect(result.target).toBe("device");
      expect(result.offline).toBe(true);
      expect(client.lastRouteWasOffline).toBe(true);
    });

    it("resets lastRouteWasOffline on successful call", async () => {
      // First: offline
      fetchSpy.mockRejectedValueOnce(new Error("Network down"));
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      expect(client.lastRouteWasOffline).toBe(true);

      // Second: online
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );
      // Clear in-memory cache to force fetch.
      await client.clearCache();
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      expect(client.lastRouteWasOffline).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Persistent cache management
  // -------------------------------------------------------------------------

  describe("cache management", () => {
    it("clearCache removes persistent file", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
      );
      await client.route("model-a", 500, 2.0, DEVICE_CAPS);

      const cacheFile = path.join(tmpDir, "octomil_routing_cache.json");
      expect(fs.existsSync(cacheFile)).toBe(true);

      await client.clearCache();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("invalidate removes a single model from persistent cache", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify(CLOUD_DECISION), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(DEVICE_DECISION), { status: 200 }),
        );

      await client.route("model-a", 500, 2.0, DEVICE_CAPS);
      await client.route("model-b", 100, 0.5, DEVICE_CAPS);

      await client.invalidate("model-a");

      // Read persistent cache file.
      const cacheFile = path.join(tmpDir, "octomil_routing_cache.json");
      const entries = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      expect(entries["model-a"]).toBeUndefined();
      expect(entries["model-b"]).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // cloudInfer
  // -------------------------------------------------------------------------

  describe("cloudInfer", () => {
    it("throws NETWORK_ERROR on fetch failure", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

      await expect(client.cloudInfer("model-a", {})).rejects.toThrow(
        "Cloud inference request failed",
      );
    });

    it("throws INFERENCE_FAILED on non-200", async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response("Bad Gateway", { status: 502 }),
      );

      await expect(client.cloudInfer("model-a", {})).rejects.toThrow(
        "Cloud inference failed: HTTP 502",
      );
    });
  });
});
