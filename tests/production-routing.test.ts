import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponsesClient } from "../src/responses.js";
import { PlannerClient } from "../src/runtime/routing/planner-client.js";
import { embedWithPlanner } from "../src/embeddings.js";
import { AudioTranscriptions } from "../src/audio/audio-transcriptions.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(lines: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("production routing integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PlannerClient calls the v2 runtime planner endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse({
          model: "phi-4-mini",
          capability: "responses",
          policy: "cloud_first",
          candidates: [],
          fallback_allowed: true,
        }),
      );

    const client = new PlannerClient({
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
    });

    await client.getPlan({
      model: "phi-4-mini",
      capability: "responses",
    });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://api.example.com/api/v2/runtime/plan",
    );
  });

  it("planner-routed responses keep injected local runtime execution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        model: "gemma3-1b",
        capability: "responses",
        policy: "local_first",
        candidates: [
          {
            locality: "local",
            engine: "llama.cpp",
            priority: 0,
            confidence: 1,
            reason: "local first",
          },
          {
            locality: "cloud",
            engine: "cloud",
            priority: 1,
            confidence: 1,
            reason: "cloud fallback",
          },
        ],
        fallback_allowed: true,
        planner_source: "server",
      }),
    );

    const localRuntime = {
      create: vi.fn().mockResolvedValue({
        id: "resp_local",
        model: "gemma3-1b",
        output: [{ type: "text", text: "local hello" }],
        finishReason: "stop",
      }),
      stream: vi.fn(),
    };

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
      }),
      localRuntime,
    });

    const response = await client.create({
      model: "gemma3-1b",
      input: "hello",
    });

    expect(response.id).toBe("resp_local");
    expect(localRuntime.create).toHaveBeenCalledOnce();
    expect(client.lastRouteInfo?.routeMetadata.execution?.mode).toBe("sdk_runtime");
    expect(client.lastRouteInfo?.routeMetadata.execution?.locality).toBe("local");
  });

  it("planner-routed responses execute against explicit external endpoints", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/api/v2/runtime/plan")) {
          return jsonResponse({
            model: "gemma3-1b",
            capability: "responses",
            policy: "local_first",
            candidates: [
              {
                locality: "local",
                engine: "local-http",
                priority: 0,
                confidence: 1,
                reason: "explicit external endpoint",
              },
            ],
            fallback_allowed: true,
            planner_source: "server",
          });
        }
        if (urlStr.endsWith("/v1/chat/completions")) {
          expect(urlStr).toBe("http://localhost:8080/v1/chat/completions");
          expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
          return jsonResponse({
            id: "resp_external",
            model: "gemma3-1b",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "external hello" },
                finish_reason: "stop",
              },
            ],
          });
        }
        throw new Error(`Unexpected URL ${urlStr}`);
      });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
      }),
      externalEndpoint: "http://localhost:8080",
    });

    const response = await client.create({
      model: "gemma3-1b",
      input: "hello",
    });

    expect(response.id).toBe("resp_external");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(client.lastRouteInfo?.routeMetadata.execution?.mode).toBe("external_endpoint");
  });

  it("planner-routed embeddings honor explicit external endpoints", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/api/v2/runtime/plan")) {
          return jsonResponse({
            model: "nomic-embed-text",
            capability: "embeddings",
            policy: "local_first",
            candidates: [
              {
                locality: "local",
                engine: "serve",
                priority: 0,
                confidence: 1,
                reason: "explicit local endpoint",
              },
            ],
            fallback_allowed: true,
          });
        }
        if (urlStr === "http://localhost:8080/v1/embeddings") {
          return jsonResponse({
            data: [{ embedding: [0.1, 0.2], index: 0 }],
            model: "nomic-embed-text",
            usage: { prompt_tokens: 2, total_tokens: 2 },
          });
        }
        throw new Error(`Unexpected URL ${urlStr}`);
      });

    const result = await embedWithPlanner(
      {
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
        plannerClient: new PlannerClient({
          serverUrl: "https://api.example.com",
          apiKey: "test-key",
        }),
        externalEndpoint: "http://localhost:8080",
      },
      "nomic-embed-text",
      "hello",
    );

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result._routeInfo?.routeMetadata?.execution?.mode).toBe("external_endpoint");
  });

  it("planner-routed audio uses hosted transcription when cloud is selected", async () => {
    const runtime = {
      createSession: vi.fn(),
      run: vi.fn().mockResolvedValue({ text: "local text" }),
      dispose: vi.fn(),
    };

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/api/v2/runtime/plan")) {
          return jsonResponse({
            model: "whisper-1",
            capability: "audio",
            policy: "cloud_first",
            candidates: [
              {
                locality: "cloud",
                engine: "cloud",
                priority: 0,
                confidence: 1,
                reason: "cloud selected",
              },
            ],
            fallback_allowed: true,
            planner_source: "server",
          });
        }
        if (urlStr.endsWith("/v1/audio/transcriptions")) {
          return jsonResponse({ text: "cloud transcript" });
        }
        throw new Error(`Unexpected URL ${urlStr}`);
      });

    const client = new AudioTranscriptions({
      runtimeResolver: vi.fn().mockReturnValue(runtime),
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
      }),
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
    });

    const result = await client.create({
      model: "whisper-1",
      audio: new Uint8Array([1, 2, 3]),
    });

    expect(result.text).toBe("cloud transcript");
    expect(runtime.run).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(client.lastRouteInfo?.routeMetadata.execution?.locality).toBe("cloud");
  });

  it("planner-routed streaming falls back to cloud before first output", async () => {
    const localRuntime = {
      create: vi.fn(),
      stream: vi.fn(async function* () {
        throw new Error("local stream failed");
      }),
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/v2/runtime/plan")) {
        return jsonResponse({
          model: "gemma3-1b",
          capability: "responses",
          policy: "local_first",
          candidates: [
            {
              locality: "local",
              engine: "llama.cpp",
              priority: 0,
              confidence: 1,
              reason: "local first",
            },
            {
              locality: "cloud",
              engine: "cloud",
              priority: 1,
              confidence: 1,
              reason: "cloud fallback",
            },
          ],
          fallback_allowed: true,
        });
      }
      if (urlStr.endsWith("/v1/chat/completions")) {
        return sseResponse([
          'data: {"id":"resp_cloud","model":"gemma3-1b","choices":[{"index":0,"delta":{"content":"cloud hello"},"finish_reason":null}]}\n',
          'data: {"id":"resp_cloud","model":"gemma3-1b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        ]);
      }
      throw new Error(`Unexpected URL ${urlStr}`);
    });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
      }),
      localRuntime,
    });

    const events = [];
    for await (const event of client.stream({
      model: "gemma3-1b",
      input: "hello",
    })) {
      events.push(event);
    }

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(client.lastRouteInfo?.routeMetadata.execution?.locality).toBe("cloud");
    expect(
      client.lastRouteInfo?.routeMetadata.fallback.used,
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Model ref kind propagation through production path
  // -------------------------------------------------------------------------

  it.each([
    ["deploy_abc123", "deployment"],
    ["exp_v1/variant_a", "experiment"],
    ["@app/my-app/chat", "app"],
    ["gemma-2b", "model"],
  ] as const)(
    "model ref '%s' propagates kind '%s' to routeMetadata via planner path",
    async (model, expectedKind) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/api/v2/runtime/plan")) {
          return jsonResponse({
            model,
            capability: "responses",
            policy: "cloud_first",
            candidates: [
              {
                locality: "cloud",
                engine: "cloud",
                priority: 0,
                confidence: 1,
                reason: "cloud selected",
              },
            ],
            fallback_allowed: true,
          });
        }
        if (urlStr.endsWith("/v1/chat/completions")) {
          return jsonResponse({
            id: `resp_${expectedKind}`,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "result" },
                finish_reason: "stop",
              },
            ],
          });
        }
        throw new Error(`Unexpected URL ${urlStr}`);
      });

      const client = new ResponsesClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
        plannerClient: new PlannerClient({
          serverUrl: "https://api.example.com",
          apiKey: "test-key",
        }),
      });

      await client.create({ model, input: "hello" });

      expect(client.lastRouteInfo?.routeMetadata.model.requested.kind).toBe(
        expectedKind,
      );
    },
  );

  it("route event from planner path never contains prompt or output content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/api/v2/runtime/plan")) {
        return jsonResponse({
          model: "test-model",
          capability: "responses",
          policy: "cloud_first",
          candidates: [
            {
              locality: "cloud",
              engine: "cloud",
              priority: 0,
              confidence: 1,
              reason: "cloud selected",
            },
          ],
          fallback_allowed: true,
        });
      }
      if (urlStr.endsWith("/v1/chat/completions")) {
        return jsonResponse({
          id: "resp_privacy",
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "SECRET_OUTPUT" },
              finish_reason: "stop",
            },
          ],
        });
      }
      throw new Error(`Unexpected URL ${urlStr}`);
    });

    const client = new ResponsesClient({
      serverUrl: "https://api.example.com",
      apiKey: "test-key",
      plannerClient: new PlannerClient({
        serverUrl: "https://api.example.com",
        apiKey: "test-key",
      }),
    });

    await client.create({ model: "test-model", input: "SECRET_PROMPT" });

    const routeInfo = client.lastRouteInfo;
    expect(routeInfo).toBeDefined();
    // The routeEvent (telemetry payload) must never contain user content.
    // The internal routeMetadata may retain attemptResult.value for SDK use,
    // but the wire-format routeEvent is the privacy boundary.
    const routeEventStr = JSON.stringify(routeInfo!.routeEvent);
    expect(routeEventStr).not.toContain("SECRET_PROMPT");
    expect(routeEventStr).not.toContain("SECRET_OUTPUT");
  });
});
