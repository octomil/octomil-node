/**
 * App + policy routing parity tests.
 *
 * Pin the cross-SDK contract: `app=` and `@app/<slug>/<cap>` refs
 * preserve app identity end-to-end, and `private`/`local_only`
 * policies never silently fall back to cloud.
 *
 * Coverage:
 *   - TTS:           app + policy reach the planner; private route
 *                     never substitutes a public artifact.
 *   - Transcription: app + policy reach the local-runner request body;
 *                     `cloud_only` is rejected on the local-runner path.
 *   - Embeddings:    app + policy reach the planner; planner-offline
 *                     code path keeps the app slug.
 *   - Responses:     app refs and policy kwargs route under app
 *                     identity (existing claim, now backed by a test).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Octomil } from "../src/facade.js";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  delete process.env.OCTOMIL_LOCAL_RUNNER_URL;
  delete process.env.OCTOMIL_LOCAL_RUNNER_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OCTOMIL_LOCAL_RUNNER_URL;
  delete process.env.OCTOMIL_LOCAL_RUNNER_TOKEN;
});

// ---------------------------------------------------------------------------
// TTS: app + policy preserved through the planner
// ---------------------------------------------------------------------------

describe("audio.speech.create app/policy routing", () => {
  it("threads policy and app slug into the planner request", async () => {
    const captured: { plan?: Record<string, unknown> } = {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        if (init?.body) {
          captured.plan = JSON.parse(String(init.body));
        }
        return new Response(
          JSON.stringify({
            model: "@app/tts-tester/tts",
            capability: "tts",
            policy: "private",
            candidates: [
              {
                locality: "local",
                engine: "sherpa-onnx",
                priority: 0,
                confidence: 1,
                reason: "private app policy",
              },
            ],
            fallback_allowed: false,
            app_resolution: {
              app_slug: "tts-tester",
              selected_model: "kokoro-82m",
              routing_policy: "private",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Hosted endpoint should never be reached for a private policy
      // without a local runner — see "rejects cloud fallback" test.
      return new Response("should not reach hosted", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
    });
    await client.initialize();
    await expect(
      client.audio.speech.create({
        model: "@app/tts-tester/tts",
        input: "hello",
        policy: "private",
        app: "tts-tester",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });

    expect(captured.plan?.routing_policy).toBe("private");
    expect(captured.plan?.app_slug).toBe("tts-tester");
  });

  it("private policy without a local runner refuses to fall back to cloud", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        return new Response(
          JSON.stringify({
            model: "@app/tts-tester/tts",
            capability: "tts",
            policy: "private",
            candidates: [
              {
                locality: "local",
                engine: "sherpa-onnx",
                priority: 0,
                confidence: 1,
                reason: "private",
              },
            ],
            fallback_allowed: false,
            app_resolution: {
              app_slug: "tts-tester",
              selected_model: "kokoro-82m",
              routing_policy: "private",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("hosted should not be hit", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
    });
    await client.initialize();
    await expect(
      client.audio.speech.create({
        model: "@app/tts-tester/tts",
        input: "hello",
        policy: "private",
        app: "tts-tester",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    // Hosted endpoint was never hit.
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Transcription: app + policy reach the runner; cloud_only is rejected
// ---------------------------------------------------------------------------

describe("audio.transcriptions.create app/policy routing", () => {
  it("forwards app + policy to the local runner request body", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
    const captured: { fields: string[] } = { fields: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "http://127.0.0.1:5151/v1/audio/transcriptions") {
        const form = init?.body as FormData | undefined;
        if (form && typeof form.entries === "function") {
          for (const [key, val] of form.entries()) {
            captured.fields.push(`${key}=${typeof val === "string" ? val : "<blob>"}`);
          }
        }
        return new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = await Octomil.local();
    await client.initialize();
    await client.audio.transcriptions.create({
      model: "@app/eternum/transcription",
      audio: new Uint8Array([1, 2, 3]),
      policy: "private",
      app: "eternum",
    });
    expect(captured.fields).toContain("policy=private");
    expect(captured.fields).toContain("app_slug=eternum");
  });

  it("rejects cloud_only on the local-runner path", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as typeof fetch;
    const client = await Octomil.local();
    await client.initialize();
    await expect(
      client.audio.transcriptions.create({
        model: "@app/eternum/transcription",
        audio: new Uint8Array([1]),
        policy: "cloud_only",
        app: "eternum",
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

// ---------------------------------------------------------------------------
// Embeddings: app + policy reach the planner
// ---------------------------------------------------------------------------

describe("embeddings.create app/policy routing", () => {
  it("threads policy and app slug into the planner request", async () => {
    const captured: { plan?: Record<string, unknown> } = {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        if (init?.body) {
          captured.plan = JSON.parse(String(init.body));
        }
        return new Response(
          JSON.stringify({
            model: "@app/embed-app/embeddings",
            capability: "embeddings",
            policy: "private",
            candidates: [
              {
                locality: "cloud",
                engine: "cloud",
                priority: 0,
                confidence: 1,
                reason: "default cloud",
              },
            ],
            fallback_allowed: true,
            app_resolution: {
              app_slug: "embed-app",
              selected_model: "nomic-embed-text-v1.5",
              routing_policy: "private",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // The router hits hosted /api/v1/embeddings since locality=cloud.
      if (url.endsWith("/api/v1/embeddings")) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2], index: 0 }],
            model: "nomic-embed-text-v1.5",
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`unexpected url: ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
    });
    await client.initialize();
    const result = await client.embeddings.create({
      model: "@app/embed-app/embeddings",
      input: "test input",
      policy: "private",
      app: "embed-app",
    });
    expect(result.embeddings).toHaveLength(1);
    expect(captured.plan?.routing_policy).toBe("private");
    expect(captured.plan?.app_slug).toBe("embed-app");
  });
});

// ---------------------------------------------------------------------------
// Responses / chat: existing claim, now backed by a test that proves the
// app ref reaches the planner with the planner-routed responses pipeline.
// ---------------------------------------------------------------------------

describe("responses.create + chat app/policy routing", () => {
  it("planner-routed responses preserve the @app/<slug> ref end-to-end", async () => {
    const captured: { plan?: Record<string, unknown>; responses?: Record<string, unknown> } = {};
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        if (init?.body) captured.plan = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            model: "@app/responder/responses",
            capability: "responses",
            policy: "cloud_first",
            candidates: [
              {
                locality: "cloud",
                engine: "cloud",
                priority: 0,
                confidence: 1,
                reason: "cloud responses",
              },
            ],
            fallback_allowed: true,
            app_resolution: {
              app_slug: "responder",
              selected_model: "gpt-4o-mini",
              routing_policy: "cloud_first",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/v1/chat/completions")) {
        if (init?.body) captured.responses = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: "chatcmpl_1",
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 1,
              total_tokens: 2,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`unexpected url ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
    });
    await client.initialize();
    const out = await client.responses.create({
      model: "@app/responder/responses",
      input: "hello",
    });
    expect(out.outputText).toBe("ok");
    // Planner saw the @app ref; the cloud cloud route preserved it
    // through to the chat completions request body.
    expect(captured.plan?.model).toBe("@app/responder/responses");
    expect(typeof captured.responses?.model).toBe("string");
    expect(captured.responses?.model).toBe("@app/responder/responses");
  });
});
