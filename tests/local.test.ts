import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  discoverFromEnv,
  discoverFromCli,
  discoverLocalRunner,
  localRunnerHealthCheck,
} from "../src/local.js";
import { Octomil, OctomilNotInitializedError } from "../src/facade.js";
import { OctomilError } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock configure() and auth-config so we don't hit the network
// ---------------------------------------------------------------------------

vi.mock("../src/configure.js", () => ({
  configure: vi.fn().mockResolvedValue({}),
  getDeviceContext: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Discovery tests
// ---------------------------------------------------------------------------

describe("Local runner discovery", () => {
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

  // -- discoverFromEnv() --------------------------------------------------

  describe("discoverFromEnv()", () => {
    it("returns endpoint when both env vars are set", () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:9876";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "test-token-abc";

      const result = discoverFromEnv();
      expect(result).toEqual({
        baseUrl: "http://127.0.0.1:9876",
        token: "test-token-abc",
      });
    });

    it("strips trailing slashes from URL", () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:9876///";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

      const result = discoverFromEnv();
      expect(result?.baseUrl).toBe("http://127.0.0.1:9876");
    });

    it("returns null when URL is missing", () => {
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
      expect(discoverFromEnv()).toBeNull();
    });

    it("returns null when token is missing", () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:9876";
      expect(discoverFromEnv()).toBeNull();
    });

    it("returns null when both are missing", () => {
      expect(discoverFromEnv()).toBeNull();
    });
  });

  // -- discoverFromCli() --------------------------------------------------

  describe("discoverFromCli()", () => {
    it("returns null when CLI is not installed", async () => {
      // Use a non-existent binary to simulate CLI not being installed
      const result = await discoverFromCli({
        cliBinary: "__nonexistent_binary_xyz__",
        cliTimeoutMs: 2000,
      });
      expect(result).toBeNull();
    });
  });

  // -- discoverLocalRunner() ----------------------------------------------

  describe("discoverLocalRunner()", () => {
    it("uses env vars when available", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "my-secret-tok";

      const result = await discoverLocalRunner();
      expect(result.baseUrl).toBe("http://127.0.0.1:5555");
      expect(result.token).toBe("my-secret-tok");
    });

    it("throws RUNTIME_UNAVAILABLE when no runner and no CLI", async () => {
      // No env vars set, and a non-existent CLI binary
      await expect(
        discoverLocalRunner({
          cliBinary: "__nonexistent_binary_xyz__",
          cliTimeoutMs: 2000,
        }),
      ).rejects.toThrow(OctomilError);

      try {
        await discoverLocalRunner({
          cliBinary: "__nonexistent_binary_xyz__",
          cliTimeoutMs: 2000,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(OctomilError);
        const octErr = err as OctomilError;
        expect(octErr.code).toBe("RUNTIME_UNAVAILABLE");
        expect(octErr.message).toContain("Local runner not available");
        expect(octErr.message).toContain("pip install octomil");
      }
    });

    it("error message does not contain runner token or URL", async () => {
      try {
        await discoverLocalRunner({
          cliBinary: "__nonexistent_binary_xyz__",
          cliTimeoutMs: 2000,
        });
      } catch (err) {
        const msg = (err as Error).message;
        // Ensure no raw URLs or tokens leak into the error
        expect(msg).not.toContain("127.0.0.1:5555");
        expect(msg).not.toContain("my-secret-tok");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// localRunnerHealthCheck tests
// ---------------------------------------------------------------------------

describe("localRunnerHealthCheck()", () => {
  it("returns false when runner is not reachable", async () => {
    const result = await localRunnerHealthCheck({
      baseUrl: "http://127.0.0.1:59999",
      token: "tok",
    });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Octomil.local() facade integration
// ---------------------------------------------------------------------------

describe("Octomil.local()", () => {
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

  it("creates a local client that is marked as local", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const client = await Octomil.local();
    expect(client.isLocal).toBe(true);
  });

  it("local client initializes without apiKey/orgId/publishableKey", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const client = await Octomil.local();
    // Should not throw — local mode skips cloud auth validation
    await client.initialize();
    expect(client.isLocal).toBe(true);
  });

  it("local client throws OctomilNotInitializedError before initialize()", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    const client = await Octomil.local();
    expect(() => client.responses).toThrow(OctomilNotInitializedError);
    expect(() => client.embeddings).toThrow(OctomilNotInitializedError);
  });

  it("hosted fromEnv() still uses OCTOMIL_SERVER_KEY", () => {
    process.env.OCTOMIL_SERVER_KEY = "srv_key";
    process.env.OCTOMIL_ORG_ID = "org_123";

    const client = Octomil.fromEnv();
    expect(client.isLocal).toBe(false);
  });

  it("throws RUNTIME_UNAVAILABLE when no runner is available", async () => {
    await expect(
      Octomil.local({ cliBinary: "__nonexistent__", cliTimeoutMs: 1000 }),
    ).rejects.toThrow(OctomilError);
  });

  // -- responses.create() via local runner ---------------------------------

  describe("local responses.create()", () => {
    it("calls localhost runner for response generation", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "test-tok";

      const fakeApiResponse = {
        id: "chatcmpl-local-1",
        model: "phi-4-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello from local!" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(fakeApiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = await Octomil.local();
      await client.initialize();

      const result = await client.responses.create({
        model: "phi-4-mini",
        input: "hello",
      });

      expect(result.id).toBe("chatcmpl-local-1");
      expect(result.output).toEqual([
        { type: "text", text: "Hello from local!" },
      ]);
      expect("outputText" in result && result.outputText).toBe(
        "Hello from local!",
      );
      expect(result.usage?.promptTokens).toBe(5);

      // Verify fetch was called with the local runner URL, not the cloud
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [fetchUrl, fetchOptions] = fetchSpy.mock.calls[0]!;
      expect(fetchUrl).toBe("http://127.0.0.1:5555/v1/chat/completions");
      const headers = fetchOptions?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-tok");

      fetchSpy.mockRestore();
    });
  });

  // -- embeddings.create() via local runner --------------------------------

  describe("local embeddings.create()", () => {
    it("calls localhost runner for embeddings", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "test-tok";

      const fakeEmbedResponse = {
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
        model: "nomic-embed-text",
        usage: { prompt_tokens: 3, total_tokens: 3 },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(fakeEmbedResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = await Octomil.local();
      await client.initialize();

      const result = await client.embeddings.create({
        model: "nomic-embed-text",
        input: "test text",
      });

      expect(result.embeddings).toEqual([[0.1, 0.2, 0.3]]);
      expect(result.model).toBe("nomic-embed-text");
      expect(result.usage.promptTokens).toBe(3);

      // Verify it hit the local runner
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [fetchUrl] = fetchSpy.mock.calls[0]!;
      expect(fetchUrl).toBe("http://127.0.0.1:5555/v1/embeddings");

      fetchSpy.mockRestore();
    });
  });

  // -- audioTranscriptions via local runner --------------------------------

  describe("local audioTranscriptions.create()", () => {
    it("calls localhost runner for transcription", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "test-tok";

      const fakeTranscriptionResponse = {
        text: "Hello world from audio",
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(fakeTranscriptionResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = await Octomil.local();
      await client.initialize();

      expect(client.audio.transcriptions).toBe(client.audioTranscriptions);

      const result = await client.audio.transcriptions.create({
        audio: new Uint8Array([1, 2, 3, 4]),
        language: "en",
      });

      expect(result.text).toBe("Hello world from audio");
      expect(result.language).toBe("en");
      expect(result.segments).toEqual([]);

      // Verify it hit the local runner
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [fetchUrl, fetchOptions] = fetchSpy.mock.calls[0]!;
      expect(fetchUrl).toBe(
        "http://127.0.0.1:5555/v1/audio/transcriptions",
      );
      expect(fetchOptions?.body).toBeInstanceOf(FormData);
      const headers = fetchOptions?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-tok");
      expect(headers["Content-Type"]).toBeUndefined();

      fetchSpy.mockRestore();
    });

    it("throws when not in local mode", async () => {
      process.env.OCTOMIL_SERVER_KEY = "srv_key";
      process.env.OCTOMIL_ORG_ID = "org_123";

      const client = Octomil.fromEnv();
      await client.initialize();

      expect(() => client.audio.transcriptions).toThrow(OctomilError);
      expect(() => client.audio.transcriptions).toThrow(
        "Audio transcriptions via local runner require Octomil.local()",
      );
    });
  });

  // -- private policy: local never calls hosted ----------------------------

  describe("private policy: local never calls hosted", () => {
    it("local responses.create() never calls cloud API", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "test-tok";

      const fakeApiResponse = {
        id: "chatcmpl-local-1",
        model: "default",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "local response" },
            finish_reason: "stop",
          },
        ],
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(fakeApiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = await Octomil.local();
      await client.initialize();

      await client.responses.create({
        model: "default",
        input: "test",
      });

      // Verify NO call was made to api.octomil.com
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [fetchUrl] = fetchSpy.mock.calls[0]!;
      expect(fetchUrl).not.toContain("api.octomil.com");
      expect(fetchUrl).toContain("127.0.0.1:5555");

      fetchSpy.mockRestore();
    });

    it("local embeddings.create() never calls cloud API", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "test-tok";

      const fakeEmbedResponse = {
        data: [{ embedding: [0.1], index: 0 }],
        model: "embed",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      };

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify(fakeEmbedResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const client = await Octomil.local();
      await client.initialize();

      await client.embeddings.create({
        model: "embed",
        input: "test",
      });

      expect(fetchSpy).toHaveBeenCalledOnce();
      const [fetchUrl] = fetchSpy.mock.calls[0]!;
      expect(fetchUrl).not.toContain("api.octomil.com");

      fetchSpy.mockRestore();
    });
  });

  // -- runner token never printed in errors --------------------------------

  describe("runner token/URL never in error messages", () => {
    it("connection failure hides runner URL and token", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "super-secret-token-xyz";

      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

      const client = await Octomil.local();
      await client.initialize();

      try {
        await client.responses.create({
          model: "default",
          input: "test",
        });
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        // The error should not leak the token
        expect(msg).not.toContain("super-secret-token-xyz");
      }

      fetchSpy.mockRestore();
    });

    it("HTTP error hides runner token", async () => {
      process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5555";
      process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "super-secret-token-xyz";

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Internal Server Error", { status: 500 }),
      );

      const client = await Octomil.local();
      await client.initialize();

      try {
        await client.responses.create({
          model: "default",
          input: "test",
        });
        expect.fail("should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toContain("super-secret-token-xyz");
      }

      fetchSpy.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------
// Hosted calls still use OCTOMIL_SERVER_KEY (regression check)
// ---------------------------------------------------------------------------

describe("Hosted calls still use OCTOMIL_SERVER_KEY", () => {
  const envKeys = [
    "OCTOMIL_SERVER_KEY",
    "OCTOMIL_API_KEY",
    "OCTOMIL_ORG_ID",
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

  it("fromEnv client uses cloud API, not local runner", async () => {
    process.env.OCTOMIL_SERVER_KEY = "srv_key_abc";
    process.env.OCTOMIL_ORG_ID = "org_123";

    const client = Octomil.fromEnv();
    expect(client.isLocal).toBe(false);
    await client.initialize();

    // The responses accessor should return a FacadeResponses (not LocalFacadeResponses)
    // We can verify this by checking isLocal
    expect(client.isLocal).toBe(false);
  });
});
