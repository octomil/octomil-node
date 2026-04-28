/**
 * Contract tests for `audio.speech.create()` and
 * `audio.transcriptions.create()` exposed via the canonical
 * `client.audio` namespace.
 *
 * Pin the cross-SDK invariants for the `create` operation:
 *   - public facade exists on `client.audio.speech.create` /
 *     `client.audio.transcriptions.create`.
 *   - response shape includes documented fields (audio bytes,
 *     content type, route metadata).
 *   - route metadata reflects the actual dispatch path (local
 *     runner vs. hosted) and never silently falls back when policy
 *     forbids it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Octomil } from "../src/facade.js";

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OCTOMIL_LOCAL_RUNNER_URL;
  delete process.env.OCTOMIL_LOCAL_RUNNER_TOKEN;
});

describe("audio.speech.create response contract", () => {
  it("hosted dispatch produces a documented response shape with route metadata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "x-octomil-provider": "openai",
          "x-octomil-billed-units": "100",
          "x-octomil-unit-kind": "char",
        },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      plannerRouting: false,
    });
    await client.initialize();
    const r = await client.audio.speech.create({
      model: "tts-1",
      input: "hello",
      voice: "alloy",
    });
    expect(r.audioBytes).toBeInstanceOf(Uint8Array);
    expect(r.contentType).toBe("audio/wav");
    expect(r.format).toBe("wav");
    expect(r.model).toBe("tts-1");
    expect(r.provider).toBe("openai");
    expect(r.route.locality).toBe("cloud");
    expect(r.billedUnits).toBe(100);
    expect(r.unitKind).toBe("char");
  });

  it("planner-routed local dispatch sets route.locality='on_device'", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
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
      if (url === "http://127.0.0.1:5151/v1/audio/speech") {
        return new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          status: 200,
          headers: { "content-type": "audio/wav" },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
    });
    await client.initialize();
    const r = await client.audio.speech.create({
      model: "@app/tts-tester/tts",
      input: "hi",
      app: "tts-tester",
      policy: "private",
    });
    expect(r.route.locality).toBe("on_device");
    expect(r.route.engine).toBeTruthy();
    expect(r.provider).toBeNull();
  });
});

describe("audio.transcriptions.create response contract", () => {
  it("local-runner dispatch returns a documented transcription shape", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const client = await Octomil.local();
    await client.initialize();
    const r = await client.audio.transcriptions.create({
      audio: new Uint8Array([1, 2, 3]),
      language: "en",
    });
    expect(r.text).toBe("hello world");
    expect(r.language).toBe("en");
    expect(Array.isArray(r.segments)).toBe(true);
  });
});

describe("embeddings.create response contract", () => {
  it("planner-routed embeddings return a documented shape", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        return new Response(
          JSON.stringify({
            model: "@app/embed-app/embeddings",
            capability: "embeddings",
            policy: "cloud_first",
            candidates: [
              {
                locality: "cloud",
                engine: "cloud",
                priority: 0,
                confidence: 1,
                reason: "cloud",
              },
            ],
            fallback_allowed: true,
            app_resolution: {
              app_slug: "embed-app",
              selected_model: "nomic-embed-text-v1.5",
              routing_policy: "cloud_first",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/api/v1/embeddings")) {
        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: "nomic-embed-text-v1.5",
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
    });
    await client.initialize();
    const r = await client.embeddings.create({
      model: "@app/embed-app/embeddings",
      input: "test",
      app: "embed-app",
    });
    expect(r.embeddings[0]).toHaveLength(3);
    expect(r.model).toBe("nomic-embed-text-v1.5");
    expect(r.usage.totalTokens).toBe(5);
  });
});

describe("responses.stream contract", () => {
  it("yields token deltas through client.responses.stream", async () => {
    // SSE chat-completions chunk shape — the responses client adapts
    // OpenAI-style chat completions chunks into canonical responses
    // stream events. Two chunks: a content delta then a [DONE].
    const sseBody =
      `data: {"id":"resp_1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n` +
      `data: {"id":"resp_1","model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;
    const fetchMock = vi.fn(async () =>
      new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      plannerRouting: false,
    });
    await client.initialize();
    const events: unknown[] = [];
    for await (const ev of client.responses.stream({
      model: "gpt-4o-mini",
      input: "hi",
    })) {
      events.push(ev);
    }
    expect(events.length).toBeGreaterThan(0);
  });
});
