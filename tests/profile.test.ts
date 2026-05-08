/**
 * Tests for src/profile.ts — staging profile resolution.
 *
 * The profile module is the single source of truth for SDK base URLs,
 * cache namespaces, and artifact buckets per environment. Pin every
 * decision branch — a regression here means staging cache poisoning
 * production or production cache leaking into staging.
 *
 * Mirrors the Python SDK's tests/test_config_profile.py in
 * octomil-python; keep them in lockstep.
 */

import { describe, expect, test } from "vitest";

import {
  Profile,
  artifactBucketFor,
  baseUrlFor,
  cacheNamespaceFor,
  profileFromString,
  resolveBaseUrl,
  resolveProfile,
} from "../src/profile";

describe("Profile constants", () => {
  test("values match canonical names used in env_capability_manifest", () => {
    expect(Profile.Production).toBe("production");
    expect(Profile.Staging).toBe("staging");
    expect(Profile.Dev).toBe("dev");
  });
});

describe("profileFromString", () => {
  test("accepts canonical names", () => {
    expect(profileFromString("production")).toBe(Profile.Production);
    expect(profileFromString("staging")).toBe(Profile.Staging);
    expect(profileFromString("dev")).toBe(Profile.Dev);
  });

  test("is case-insensitive", () => {
    expect(profileFromString("STAGING")).toBe(Profile.Staging);
    expect(profileFromString("Staging")).toBe(Profile.Staging);
  });

  test("accepts operator aliases prod / stg", () => {
    expect(profileFromString("prod")).toBe(Profile.Production);
    expect(profileFromString("stg")).toBe(Profile.Staging);
  });

  test("rejects unknown profiles", () => {
    expect(() => profileFromString("preview")).toThrow(/unknown profile/);
  });

  test("rejects empty string", () => {
    expect(() => profileFromString("")).toThrow(/non-empty/);
  });
});

describe("baseUrlFor", () => {
  test("production URL does not include 'staging' substring", () => {
    // Critical safety pin — if production ever drifts to a
    // staging-shaped URL, the SDK silently routes prod traffic to
    // staging.
    const url = baseUrlFor(Profile.Production);
    expect(url).not.toContain("staging");
    expect(url).toBe("https://api.octomil.com/v1");
  });

  test("staging URL is distinct from production", () => {
    expect(baseUrlFor(Profile.Staging)).not.toBe(baseUrlFor(Profile.Production));
    expect(baseUrlFor(Profile.Staging)).toBe(
      "https://api.staging.octomil.com/v1",
    );
  });

  test("dev URL is localhost-shaped", () => {
    expect(baseUrlFor(Profile.Dev).startsWith("http://localhost")).toBe(true);
  });
});

describe("artifactBucketFor", () => {
  test("each profile has a distinct bucket name", () => {
    const buckets = new Set([
      artifactBucketFor(Profile.Production),
      artifactBucketFor(Profile.Staging),
      artifactBucketFor(Profile.Dev),
    ]);
    expect(buckets.size).toBe(3);
    expect(artifactBucketFor(Profile.Production)).toBe("octomil-models");
    expect(artifactBucketFor(Profile.Staging)).toBe("octomil-models-staging");
  });

  test("staging bucket name does not contain 'prod'", () => {
    // A regression like 'octomil-models-prod' would silently route
    // staging artifacts through prod.
    expect(artifactBucketFor(Profile.Staging).toLowerCase()).not.toContain("prod");
  });
});

describe("cacheNamespaceFor", () => {
  test("namespace embeds the profile name", () => {
    expect(cacheNamespaceFor(Profile.Production)).toBe("oct.production");
    expect(cacheNamespaceFor(Profile.Staging)).toBe("oct.staging");
    expect(cacheNamespaceFor(Profile.Dev)).toBe("oct.dev");
  });

  test("no two profiles share a namespace", () => {
    const namespaces = new Set([
      cacheNamespaceFor(Profile.Production),
      cacheNamespaceFor(Profile.Staging),
      cacheNamespaceFor(Profile.Dev),
    ]);
    expect(namespaces.size).toBe(3);
  });
});

describe("resolveProfile — explicit argument", () => {
  test("explicit arg wins over env", () => {
    const res = resolveProfile({
      profile: "staging",
      env: { OCTOMIL_PROFILE: "production" },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("explicit");
  });

  test("aliases resolve", () => {
    expect(resolveProfile({ profile: "prod", env: {} }).profile).toBe(
      Profile.Production,
    );
  });

  test("empty explicit arg falls through to env", () => {
    const res = resolveProfile({
      profile: "  ",
      env: { OCTOMIL_PROFILE: "staging" },
    });
    expect(res.source).toBe("env");
  });

  test("invalid explicit arg raises", () => {
    expect(() =>
      resolveProfile({ profile: "preview", env: {} }),
    ).toThrow(/unknown profile/);
  });
});

describe("resolveProfile — env var", () => {
  test("OCTOMIL_PROFILE picks staging", () => {
    const res = resolveProfile({ env: { OCTOMIL_PROFILE: "staging" } });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("env");
  });

  test("empty OCTOMIL_PROFILE falls through (treated as unset)", () => {
    const res = resolveProfile({ env: { OCTOMIL_PROFILE: "" } });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });

  test("OCTOMIL_PROFILE is case-insensitive", () => {
    const res = resolveProfile({ env: { OCTOMIL_PROFILE: "STAGING" } });
    expect(res.profile).toBe(Profile.Staging);
  });
});

describe("resolveProfile — URL inference", () => {
  test("infers staging from OCTOMIL_API_BASE", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://api.staging.octomil.com/v1" },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("url_inferred");
  });

  test("infers production from OCTOMIL_API_URL", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_URL: "https://api.octomil.com/v1" },
    });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("url_inferred");
  });

  test("infers dev from localhost", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "http://localhost:8000" },
    });
    expect(res.profile).toBe(Profile.Dev);
  });

  test("infers dev from 127.0.0.1", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "http://127.0.0.1:8000" },
    });
    expect(res.profile).toBe(Profile.Dev);
  });

  test("explicit OCTOMIL_PROFILE overrides URL inference", () => {
    const res = resolveProfile({
      env: {
        OCTOMIL_PROFILE: "staging",
        OCTOMIL_API_BASE: "https://api.octomil.com/v1",
      },
    });
    expect(res.profile).toBe(Profile.Staging);
    expect(res.source).toBe("env");
  });

  test("unmatched URL falls through to default", () => {
    const res = resolveProfile({
      env: { OCTOMIL_API_BASE: "https://example.com/api" },
    });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });
});

describe("resolveProfile — default", () => {
  test("no signals defaults to production", () => {
    const res = resolveProfile({ env: {} });
    expect(res.profile).toBe(Profile.Production);
    expect(res.source).toBe("default");
  });
});

describe("resolveBaseUrl", () => {
  test("explicit baseUrl wins over profile resolution", () => {
    const url = resolveBaseUrl({
      baseUrl: "https://custom.example.com",
      env: { OCTOMIL_PROFILE: "staging" },
    });
    expect(url).toBe("https://custom.example.com");
  });

  test("uses profile-derived URL when no explicit baseUrl", () => {
    const url = resolveBaseUrl({ env: { OCTOMIL_PROFILE: "staging" } });
    expect(url).toBe("https://api.staging.octomil.com/v1");
  });

  test("default returns production URL", () => {
    const url = resolveBaseUrl({ env: {} });
    expect(url).toBe("https://api.octomil.com/v1");
  });

  test("empty baseUrl string falls through to profile resolution", () => {
    const url = resolveBaseUrl({
      baseUrl: "  ",
      env: { OCTOMIL_PROFILE: "staging" },
    });
    expect(url).toBe("https://api.staging.octomil.com/v1");
  });
});

describe("cross-profile isolation", () => {
  test("no two profiles share a base URL", () => {
    const urls = new Set([
      baseUrlFor(Profile.Production),
      baseUrlFor(Profile.Staging),
      baseUrlFor(Profile.Dev),
    ]);
    expect(urls.size).toBe(3);
  });
});
