import { describe, it, expect } from "vitest";
import {
  validatePublishableKey,
  getPublishableKeyEnvironment,
  PublishableKeyAuth,
} from "../src/auth-config.js";
import { Scope } from "../src/_generated/scope.js";

describe("validatePublishableKey", () => {
  it("should accept oct_pub_test_ prefix", () => {
    expect(() => validatePublishableKey("oct_pub_test_abc123")).not.toThrow();
  });

  it("should accept oct_pub_live_ prefix", () => {
    expect(() => validatePublishableKey("oct_pub_live_xyz789")).not.toThrow();
  });

  it("should reject invalid prefix", () => {
    expect(() => validatePublishableKey("sk_test_abc")).toThrow(
      "Publishable key must start with",
    );
  });

  it("should reject empty string", () => {
    expect(() => validatePublishableKey("")).toThrow(
      "Publishable key must start with",
    );
  });

  it("should reject partial prefix", () => {
    expect(() => validatePublishableKey("oct_pub_")).toThrow(
      "Publishable key must start with",
    );
  });
});

describe("getPublishableKeyEnvironment", () => {
  it("should return test for test key", () => {
    expect(getPublishableKeyEnvironment("oct_pub_test_abc")).toBe("test");
  });

  it("should return live for live key", () => {
    expect(getPublishableKeyEnvironment("oct_pub_live_xyz")).toBe("live");
  });

  it("should return null for unknown prefix", () => {
    expect(getPublishableKeyEnvironment("sk_test_abc")).toBeNull();
  });
});

describe("PublishableKeyAuth", () => {
  describe("constructor", () => {
    it("should accept a valid test publishable key", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc123");
      expect(auth.key).toBe("oct_pub_test_abc123");
      expect(auth.environment).toBe("test");
      expect(auth.type).toBe("publishable_key");
    });

    it("should accept a valid live publishable key", () => {
      const auth = new PublishableKeyAuth("oct_pub_live_xyz789");
      expect(auth.key).toBe("oct_pub_live_xyz789");
      expect(auth.environment).toBe("live");
    });

    it("should reject an invalid key", () => {
      expect(() => new PublishableKeyAuth("sk_test_bad")).toThrow(
        "Publishable key must start with",
      );
    });

    it("should reject an empty string", () => {
      expect(() => new PublishableKeyAuth("")).toThrow(
        "Publishable key must start with",
      );
    });

    it("should reject oct_pub_ without environment segment", () => {
      expect(() => new PublishableKeyAuth("oct_pub_abc")).toThrow(
        "Publishable key must start with",
      );
    });
  });

  describe("allowedScopes", () => {
    it("should return a set containing the four publishable-key-safe scopes", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      const scopes = auth.allowedScopes;

      expect(scopes.has(Scope.DevicesRegister)).toBe(true);
      expect(scopes.has(Scope.DevicesHeartbeat)).toBe(true);
      expect(scopes.has(Scope.TelemetryWrite)).toBe(true);
      expect(scopes.has(Scope.ModelsRead)).toBe(true);
    });

    it("should not contain privileged scopes", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      const scopes = auth.allowedScopes;

      expect(scopes.has(Scope.ModelsWrite)).toBe(false);
      expect(scopes.has(Scope.RolloutsWrite)).toBe(false);
      expect(scopes.has(Scope.RolloutsRead)).toBe(false);
      expect(scopes.has(Scope.CatalogRead)).toBe(false);
      expect(scopes.has(Scope.ControlRefresh)).toBe(false);
      expect(scopes.has(Scope.BenchmarksWrite)).toBe(false);
      expect(scopes.has(Scope.EvalsWrite)).toBe(false);
    });

    it("should have exactly 4 scopes", () => {
      const auth = new PublishableKeyAuth("oct_pub_live_abc");
      expect(auth.allowedScopes.size).toBe(4);
    });
  });

  describe("hasScope", () => {
    it("should return true for allowed scopes", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      expect(auth.hasScope(Scope.DevicesRegister)).toBe(true);
      expect(auth.hasScope(Scope.TelemetryWrite)).toBe(true);
    });

    it("should return false for disallowed scopes", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      expect(auth.hasScope(Scope.ModelsWrite)).toBe(false);
      expect(auth.hasScope(Scope.RolloutsWrite)).toBe(false);
    });
  });

  describe("requireScope", () => {
    it("should not throw for allowed scopes", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      expect(() => auth.requireScope(Scope.DevicesRegister)).not.toThrow();
      expect(() => auth.requireScope(Scope.DevicesHeartbeat)).not.toThrow();
      expect(() => auth.requireScope(Scope.TelemetryWrite)).not.toThrow();
      expect(() => auth.requireScope(Scope.ModelsRead)).not.toThrow();
    });

    it("should throw for disallowed scopes with descriptive message", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      expect(() => auth.requireScope(Scope.ModelsWrite)).toThrow(
        "Scope 'models:write' is not allowed for publishable key auth",
      );
    });

    it("should include allowed scopes in error message", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc");
      expect(() => auth.requireScope(Scope.RolloutsWrite)).toThrow(
        "Allowed scopes:",
      );
    });
  });

  describe("headers", () => {
    it("should return X-API-Key header with the key value", () => {
      const auth = new PublishableKeyAuth("oct_pub_test_abc123");
      expect(auth.headers()).toEqual({ "X-API-Key": "oct_pub_test_abc123" });
    });

    it("should return same key for live environment", () => {
      const auth = new PublishableKeyAuth("oct_pub_live_xyz789");
      expect(auth.headers()).toEqual({ "X-API-Key": "oct_pub_live_xyz789" });
    });
  });
});
