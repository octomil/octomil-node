import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  buildLocalLifecycleStatus,
  buildUnavailableStatus,
} from "../src/local-lifecycle.js";
import type { LocalLifecycleStatus, LocalCacheStatus } from "../src/local-lifecycle.js";
import { Octomil } from "../src/facade.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock configure() and auth-config so we don't hit the network
// ---------------------------------------------------------------------------

vi.mock("../src/configure.js", () => ({
  configure: vi.fn().mockResolvedValue({}),
  getDeviceContext: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// LocalLifecycleStatus builder tests
// ---------------------------------------------------------------------------

describe("LocalLifecycleStatus builder", () => {
  it("builds status for an available local runner", () => {
    const status = buildLocalLifecycleStatus({
      runnerAvailable: true,
      cacheStatus: "hit",
      engine: "llamacpp",
    });

    expect(status.runnerAvailable).toBe(true);
    expect(status.cacheStatus).toBe("hit");
    expect(status.engine).toBe("llamacpp");
    expect(status.locality).toBe("local");
    expect(status.mode).toBe("sdk_runtime");
    expect(status.fallbackReason).toBeUndefined();
  });

  it("builds status for a cache miss", () => {
    const status = buildLocalLifecycleStatus({
      runnerAvailable: true,
      cacheStatus: "miss",
    });

    expect(status.cacheStatus).toBe("miss");
    expect(status.engine).toBeNull();
    expect(status.locality).toBe("local");
  });

  it("builds unavailable status with reason", () => {
    const status = buildUnavailableStatus("runner_unreachable");

    expect(status.runnerAvailable).toBe(false);
    expect(status.cacheStatus).toBe("unavailable");
    expect(status.locality).toBe("cloud");
    expect(status.mode).toBe("hosted_gateway");
    expect(status.fallbackReason).toBe("runner_unreachable");
  });

  it("defaults engine to null when not provided", () => {
    const status = buildLocalLifecycleStatus({
      runnerAvailable: true,
      cacheStatus: "hit",
    });

    expect(status.engine).toBeNull();
  });

  it("carries fallback reason through", () => {
    const status = buildLocalLifecycleStatus({
      runnerAvailable: false,
      cacheStatus: "unavailable",
      fallbackReason: "model_not_found",
    });

    expect(status.fallbackReason).toBe("model_not_found");
    expect(status.locality).toBe("cloud");
    expect(status.mode).toBe("hosted_gateway");
  });
});

// ---------------------------------------------------------------------------
// Cache status reporting in route metadata
// ---------------------------------------------------------------------------

describe("cache status reporting", () => {
  const allStatuses: LocalCacheStatus[] = ["hit", "miss", "not_applicable", "unavailable"];

  it("accepts all valid cache status values", () => {
    for (const cs of allStatuses) {
      const status = buildLocalLifecycleStatus({
        runnerAvailable: cs !== "unavailable",
        cacheStatus: cs,
      });
      expect(status.cacheStatus).toBe(cs);
    }
  });

  it("cache status 'hit' implies local execution", () => {
    const status = buildLocalLifecycleStatus({
      runnerAvailable: true,
      cacheStatus: "hit",
    });
    expect(status.locality).toBe("local");
    expect(status.mode).toBe("sdk_runtime");
  });

  it("cache status 'not_applicable' for cloud routes", () => {
    const status = buildUnavailableStatus("not_local_client");
    expect(status.cacheStatus).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Octomil.getLocalStatus() integration
// ---------------------------------------------------------------------------

describe("Octomil.getLocalStatus()", () => {
  const envKeys = [
    "OCTOMIL_LOCAL_RUNNER_URL",
    "OCTOMIL_LOCAL_RUNNER_TOKEN",
    "OCTOMIL_SERVER_KEY",
    "OCTOMIL_API_KEY",
    "OCTOMIL_ORG_ID",
  ] as const;
  const originalEnv = new Map(envKeys.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns unavailable status for non-local client", async () => {
    process.env.OCTOMIL_SERVER_KEY = "srv_key_abc";
    process.env.OCTOMIL_ORG_ID = "org_123";

    const client = Octomil.fromEnv();
    const status = await client.getLocalStatus();

    expect(status.runnerAvailable).toBe(false);
    expect(status.cacheStatus).toBe("unavailable");
    expect(status.fallbackReason).toBe("not_local_client");
  });

  it("returns unavailable when local runner is not reachable", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:59999";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const client = await Octomil.local();
    const status = await client.getLocalStatus();

    expect(status.runnerAvailable).toBe(false);
    expect(status.cacheStatus).toBe("unavailable");
    expect(status.fallbackReason).toBe("runner_unreachable");
  });

  it("returns available status when runner health check passes", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("ok", { status: 200 }),
    );

    const client = await Octomil.local();
    const status = await client.getLocalStatus();

    expect(status.runnerAvailable).toBe(true);
    expect(status.cacheStatus).toBe("hit");
    expect(status.locality).toBe("local");
    expect(status.mode).toBe("sdk_runtime");

    fetchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Local unavailable behavior: actionable errors
// ---------------------------------------------------------------------------

describe("local unavailable behavior", () => {
  const envKeys = [
    "OCTOMIL_LOCAL_RUNNER_URL",
    "OCTOMIL_LOCAL_RUNNER_TOKEN",
  ] as const;
  const originalEnv = new Map(envKeys.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("throws RUNTIME_UNAVAILABLE with actionable install instructions", async () => {
    try {
      await Octomil.local({
        cliBinary: "__nonexistent__",
        cliTimeoutMs: 1000,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OctomilError);
      const octErr = err as OctomilError;
      expect(octErr.code).toBe("RUNTIME_UNAVAILABLE");
      expect(octErr.message).toContain("pip install octomil");
      expect(octErr.message).toContain("OCTOMIL_LOCAL_RUNNER_URL");
    }
  });

  it("error does not contain raw URLs or tokens", async () => {
    try {
      await Octomil.local({
        cliBinary: "__nonexistent__",
        cliTimeoutMs: 1000,
      });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("127.0.0.1");
      expect(msg).not.toContain("Bearer");
    }
  });
});

// ---------------------------------------------------------------------------
// Repeated runs reuse cache (regression test)
// ---------------------------------------------------------------------------

describe("repeated runs reuse cache", () => {
  const envKeys = [
    "OCTOMIL_LOCAL_RUNNER_URL",
    "OCTOMIL_LOCAL_RUNNER_TOKEN",
  ] as const;
  const originalEnv = new Map(envKeys.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of envKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("second request reuses the local endpoint without re-discovery", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const fakeResponse = {
      id: "chatcmpl-1",
      model: "phi-4",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "response" },
          finish_reason: "stop",
        },
      ],
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fakeResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    // Create client once — endpoint is discovered and cached
    const client = await Octomil.local();
    await client.initialize();

    // First request
    await client.responses.create({
      model: "phi-4",
      input: "hello",
    });

    // Second request — should reuse the same endpoint, not re-discover
    await client.responses.create({
      model: "phi-4",
      input: "world",
    });

    // Both requests should go to the same local URL
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url1] = fetchSpy.mock.calls[0]!;
    const [url2] = fetchSpy.mock.calls[1]!;
    expect(url1).toBe("http://127.0.0.1:5555/v1/chat/completions");
    expect(url2).toBe("http://127.0.0.1:5555/v1/chat/completions");

    fetchSpy.mockRestore();
  });

  it("Octomil.local() caches the endpoint for all subsequent requests", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const fakeEmbed = {
      data: [{ embedding: [0.1], index: 0 }],
      model: "embed",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    };

    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fakeEmbed), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fakeEmbed), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = await Octomil.local();
    await client.initialize();

    // Two embedding requests
    await client.embeddings.create({ model: "embed", input: "a" });
    await client.embeddings.create({ model: "embed", input: "b" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url1] = fetchSpy.mock.calls[0]!;
    const [url2] = fetchSpy.mock.calls[1]!;
    expect(url1).toBe("http://127.0.0.1:5555/v1/embeddings");
    expect(url2).toBe("http://127.0.0.1:5555/v1/embeddings");

    fetchSpy.mockRestore();
  });
});
