import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ControlClient } from "../src/control.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    body: null,
    headers: new Headers(),
  } as unknown as Response;
}

const REGISTRATION_RESPONSE = {
  id: "dev-123",
  device_identifier: "test-host-darwin-arm64",
  org_id: "org-456",
  status: "active",
};

const HEARTBEAT_RESPONSE = {
  status: "ok",
  server_time: "2026-03-12T12:00:00Z",
};

const ASSIGNMENTS_RESPONSE = [
  { modelId: "phi-4-mini", version: "1.0", config: {} },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ControlClient", () => {
  let client: ControlClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    client = new ControlClient("https://api.test.com", "test-key", "org-456");
  });

  afterEach(() => {
    client.stopHeartbeat();
  });

  // ---- register() ---------------------------------------------------------

  describe("register()", () => {
    it("sends registration request and stores device ID", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(REGISTRATION_RESPONSE),
      );

      const result = await client.register("my-device");

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/register");
      expect(init!.method).toBe("POST");

      const body = JSON.parse(init!.body as string);
      expect(body.device_identifier).toBe("my-device");
      expect(body.org_id).toBe("org-456");

      expect(result.id).toBe("dev-123");
      expect(result.deviceIdentifier).toBe("test-host-darwin-arm64");
      expect(result.orgId).toBe("org-456");
      expect(result.status).toBe("active");

      // Device ID should be stored
      expect(client.getDeviceId()).toBe("dev-123");
    });

    it("generates default device identifier when none provided", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(REGISTRATION_RESPONSE),
      );

      await client.register();

      const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      // Should contain hostname-platform-arch
      expect(body.device_identifier).toMatch(/.+-.+-.+/);
    });

    it("throws OctomilError on HTTP error", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Forbidden", { status: 403 }),
      );

      await expect(client.register("x")).rejects.toThrow(OctomilError);
    });

    it("throws OctomilError on network error", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

      await expect(client.register("x")).rejects.toThrow(OctomilError);
    });
  });

  // ---- heartbeat() --------------------------------------------------------

  describe("heartbeat()", () => {
    it("sends heartbeat and returns parsed response", async () => {
      client.setDeviceId("dev-123");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(HEARTBEAT_RESPONSE),
      );

      const result = await client.heartbeat();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/dev-123/heartbeat");

      expect(result.status).toBe("ok");
      expect(result.serverTime).toBe("2026-03-12T12:00:00Z");
    });

    it("throws if device is not registered", async () => {
      await expect(client.heartbeat()).rejects.toThrow("Device not registered");
    });

    it("throws OctomilError on HTTP error", async () => {
      client.setDeviceId("dev-123");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Server Error", { status: 500 }),
      );

      await expect(client.heartbeat()).rejects.toThrow(OctomilError);
    });

    it("throws OctomilError on network error", async () => {
      client.setDeviceId("dev-123");
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));

      await expect(client.heartbeat()).rejects.toThrow(OctomilError);
    });
  });

  // ---- refresh() ----------------------------------------------------------

  describe("refresh()", () => {
    it("fetches device assignments", async () => {
      client.setDeviceId("dev-123");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(ASSIGNMENTS_RESPONSE),
      );

      const result = await client.refresh();

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/dev-123/assignments");
      expect(result).toHaveLength(1);
      expect(result[0]!.modelId).toBe("phi-4-mini");
    });

    it("throws if device is not registered", async () => {
      await expect(client.refresh()).rejects.toThrow("Device not registered");
    });

    it("throws OctomilError on HTTP error", async () => {
      client.setDeviceId("dev-123");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not Found", { status: 404 }),
      );

      await expect(client.refresh()).rejects.toThrow(OctomilError);
    });
  });

  // ---- startHeartbeat / stopHeartbeat -------------------------------------

  describe("startHeartbeat() / stopHeartbeat()", () => {
    it("starts and stops periodic heartbeat", () => {
      client.setDeviceId("dev-123");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(HEARTBEAT_RESPONSE),
      );

      vi.useFakeTimers();
      client.startHeartbeat(1000);

      // Advance time to trigger one heartbeat
      vi.advanceTimersByTime(1000);
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      // Stop and advance — should not trigger another
      client.stopHeartbeat();
      vi.advanceTimersByTime(2000);
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      vi.useRealTimers();
    });

    it("replaces existing heartbeat when called again", () => {
      client.setDeviceId("dev-123");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(HEARTBEAT_RESPONSE),
      );

      vi.useFakeTimers();
      client.startHeartbeat(1000);
      client.startHeartbeat(2000); // Replaces the first

      vi.advanceTimersByTime(1500);
      // First timer would have fired at 1000ms, but it was cleared
      expect(globalThis.fetch).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      // Second timer fires at 2000ms
      expect(globalThis.fetch).toHaveBeenCalledOnce();

      client.stopHeartbeat();
      vi.useRealTimers();
    });
  });

  // ---- setDeviceId / getDeviceId ------------------------------------------

  describe("setDeviceId() / getDeviceId()", () => {
    it("returns null before registration", () => {
      expect(client.getDeviceId()).toBeNull();
    });

    it("returns set device ID", () => {
      client.setDeviceId("manual-id");
      expect(client.getDeviceId()).toBe("manual-id");
    });
  });

  // ---- URL handling -------------------------------------------------------

  describe("URL handling", () => {
    it("strips trailing slashes from serverUrl", async () => {
      const c = new ControlClient("https://api.test.com///", "key", "org");
      c.setDeviceId("dev-1");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        mockJsonResponse(HEARTBEAT_RESPONSE),
      );

      await c.heartbeat();

      const [url] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.test.com/api/v1/devices/dev-1/heartbeat");
    });
  });
});
