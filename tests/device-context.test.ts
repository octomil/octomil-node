import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeviceContext } from "../src/device-context.js";

// Mock fs/crypto for tests
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("test-uuid-1234-5678-abcd-efgh"),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe("DeviceContext", () => {
  describe("constructor", () => {
    it("should store installationId", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.installationId).toBe("inst-123");
    });

    it("should default orgId and appId to null", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.orgId).toBeNull();
      expect(ctx.appId).toBeNull();
    });

    it("should store orgId and appId when provided", () => {
      const ctx = new DeviceContext({
        installationId: "inst-123",
        orgId: "org-456",
        appId: "app-789",
      });
      expect(ctx.orgId).toBe("org-456");
      expect(ctx.appId).toBe("app-789");
    });
  });

  describe("initial state", () => {
    it("should start with pending registration", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.registrationState).toBe("pending");
    });

    it("should start with no token", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.tokenState).toEqual({ type: "none" });
    });

    it("should not be registered initially", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.isRegistered).toBe(false);
    });

    it("should have null serverDeviceId initially", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.serverDeviceId).toBeNull();
    });
  });

  describe("authHeaders", () => {
    it("should return null when no token", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      expect(ctx.authHeaders()).toBeNull();
    });

    it("should return bearer header when token is valid", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const futureDate = new Date(Date.now() + 3600_000);
      ctx._updateRegistered("dev-1", "token-abc", futureDate);

      const headers = ctx.authHeaders();
      expect(headers).toEqual({ Authorization: "Bearer token-abc" });
    });

    it("should return null when token is expired", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const pastDate = new Date(Date.now() - 1000);
      ctx._updateRegistered("dev-1", "token-abc", pastDate);

      expect(ctx.authHeaders()).toBeNull();
    });
  });

  describe("telemetryResource", () => {
    it("should include device.id and platform", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const resource = ctx.telemetryResource();
      expect(resource["device.id"]).toBe("inst-123");
      expect(resource["platform"]).toBe("node");
    });

    it("should include octomil.install.id with the installation ID", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const resource = ctx.telemetryResource();
      expect(resource["octomil.install.id"]).toBe("inst-123");
    });

    it("should include org.id when set", () => {
      const ctx = new DeviceContext({
        installationId: "inst-123",
        orgId: "org-456",
      });
      const resource = ctx.telemetryResource();
      expect(resource["org.id"]).toBe("org-456");
    });

    it("should include app.id when set", () => {
      const ctx = new DeviceContext({
        installationId: "inst-123",
        appId: "app-789",
      });
      const resource = ctx.telemetryResource();
      expect(resource["app.id"]).toBe("app-789");
    });

    it("should omit org.id and app.id when null", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const resource = ctx.telemetryResource();
      expect(resource).not.toHaveProperty("org.id");
      expect(resource).not.toHaveProperty("app.id");
    });
  });

  describe("state mutations", () => {
    it("_updateRegistered should set registered state", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const expiresAt = new Date(Date.now() + 3600_000);
      ctx._updateRegistered("dev-1", "token-abc", expiresAt);

      expect(ctx.registrationState).toBe("registered");
      expect(ctx.isRegistered).toBe(true);
      expect(ctx.serverDeviceId).toBe("dev-1");
      expect(ctx.tokenState).toEqual({
        type: "valid",
        accessToken: "token-abc",
        expiresAt,
      });
    });

    it("_updateToken should update token", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      const expiresAt = new Date(Date.now() + 3600_000);
      ctx._updateToken("new-token", expiresAt);

      expect(ctx.tokenState).toEqual({
        type: "valid",
        accessToken: "new-token",
        expiresAt,
      });
    });

    it("_markFailed should set failed state", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      ctx._markFailed();
      expect(ctx.registrationState).toBe("failed");
      expect(ctx.isRegistered).toBe(false);
    });

    it("_markTokenExpired should set expired token", () => {
      const ctx = new DeviceContext({ installationId: "inst-123" });
      ctx._markTokenExpired();
      expect(ctx.tokenState).toEqual({ type: "expired" });
    });
  });

  describe("getOrCreateInstallationId", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("should return existing ID from file", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("existing-id-123");

      const id = DeviceContext.getOrCreateInstallationId();
      expect(id).toBe("existing-id-123");
    });

    it("should generate and persist new ID when file doesn't exist", async () => {
      const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const id = DeviceContext.getOrCreateInstallationId();
      expect(id).toBe("test-uuid-1234-5678-abcd-efgh");
      expect(mkdirSync).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalled();
    });

    it("should return ephemeral ID when write fails", async () => {
      const { existsSync, writeFileSync, mkdirSync } = await import("node:fs");
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("EACCES");
      });

      const id = DeviceContext.getOrCreateInstallationId();
      expect(id).toBe("test-uuid-1234-5678-abcd-efgh");
    });
  });
});
