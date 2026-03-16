import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configure, getDeviceContext } from "../src/configure.js";
import { DeviceContext } from "../src/device-context.js";

// Mock DeviceContext static
vi.spyOn(DeviceContext, "getOrCreateInstallationId").mockReturnValue("mock-install-id");

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("configure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create a DeviceContext with installation id", async () => {
    const ctx = await configure();
    expect(ctx).toBeInstanceOf(DeviceContext);
    expect(ctx.installationId).toBe("mock-install-id");
  });

  it("should set module-level device context", async () => {
    const ctx = await configure();
    expect(getDeviceContext()).toBe(ctx);
  });

  it("should validate publishable key at configure time", async () => {
    await expect(
      configure({ auth: { type: "publishable_key", key: "invalid_key" } }),
    ).rejects.toThrow("Publishable key must start with");
  });

  it("should accept valid publishable key", async () => {
    const ctx = await configure({
      auth: { type: "publishable_key", key: "oct_pub_test_abc123" },
    });
    expect(ctx.installationId).toBe("mock-install-id");
  });

  it("should set appId for anonymous auth", async () => {
    const ctx = await configure({
      auth: { type: "anonymous", appId: "my-app" },
    });
    expect(ctx.appId).toBe("my-app");
  });

  it("should not register when monitoring is disabled", async () => {
    await configure({
      auth: { type: "publishable_key", key: "oct_pub_test_abc" },
      monitoring: { enabled: false },
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should not register when auth is not provided", async () => {
    await configure({ monitoring: { enabled: true } });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should trigger background registration when auth + monitoring enabled", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        device_id: "dev-1",
        access_token: "tok-abc",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      }),
    });

    const ctx = await configure({
      auth: { type: "publishable_key", key: "oct_pub_test_abc" },
      monitoring: { enabled: true },
      baseUrl: "https://test.api.com",
    });

    // Wait a tick for fire-and-forget to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockFetch).toHaveBeenCalledWith(
      "https://test.api.com/api/v1/devices/register",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("should mark context failed on 403", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const ctx = await configure({
      auth: { type: "publishable_key", key: "oct_pub_test_abc" },
      monitoring: { enabled: true },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.registrationState).toBe("failed");
  });
});
