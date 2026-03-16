import { describe, it, expect } from "vitest";
import {
  validatePublishableKey,
  getPublishableKeyEnvironment,
} from "../src/auth-config.js";

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
