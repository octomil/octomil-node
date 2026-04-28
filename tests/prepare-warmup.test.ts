/**
 * Warmup contract tests.
 *
 * Pins the cross-SDK warmup invariants:
 *   - `warmup` runs prepare end-to-end (bytes on disk, digest verified).
 *   - The loaded backend handle survives on the client.
 *   - The next `audio.speech.create({model})` call reuses the warmed
 *     handle: route metadata reflects the warmed engine and the
 *     facade's runner request includes the prepared `warm_model_dir`.
 *
 * Mirrors Python `client.warmup(...)` -> `client.audio.speech.create(...)`.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Octomil } from "../src/facade.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "octomil-warmup-"));
});

afterEach(async () => {
  delete process.env.OCTOMIL_LOCAL_RUNNER_URL;
  delete process.env.OCTOMIL_LOCAL_RUNNER_TOKEN;
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function sha256(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

// Fake planner + runner. Three URLs are exercised:
//   - /api/v2/runtime/plan       -> planner with a preparable candidate
//   - https://cdn.example/k.onnx -> bytes for the artifact
//   - http://127.0.0.1:5151/...  -> local runner for create() dispatch
function buildFetchMock(
  bytes: Buffer,
  options: {
    digest: string;
    requiredFiles: string[];
    appSlug: string;
    runnerUrl: string;
    onRunnerBody: (body: Record<string, unknown>) => void;
    capturePlanRequest: (body: Record<string, unknown>) => void;
  },
): {
  fetchMock: ReturnType<typeof vi.fn>;
  runnerCalls: number;
} {
  let runnerCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v2/runtime/plan")) {
      if (init?.body) {
        try {
          options.capturePlanRequest(JSON.parse(String(init.body)));
        } catch {
          // ignore — body inspection is best-effort
        }
      }
      return new Response(
        JSON.stringify({
          model: `@app/${options.appSlug}/tts`,
          capability: "tts",
          policy: "private",
          candidates: [
            {
              locality: "local",
              engine: "sherpa-onnx",
              priority: 0,
              confidence: 1,
              reason: "private app policy",
              delivery_mode: "sdk_runtime",
              prepare_required: true,
              prepare_policy: "lazy",
              artifact: {
                model_id: "kokoro-en-v0_19",
                artifact_id: "kokoro-en-v0_19",
                digest: options.digest,
                download_urls: [{ url: "https://cdn.example/k.onnx" }],
                required_files: options.requiredFiles,
              },
            },
          ],
          fallback_allowed: false,
          app_resolution: {
            app_slug: options.appSlug,
            selected_model: "kokoro-en-v0_19",
            routing_policy: "private",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://cdn.example/k.onnx") {
      return new Response(bytes, { status: 200 });
    }
    if (url === options.runnerUrl) {
      runnerCalls += 1;
      if (init?.body) {
        try {
          options.onRunnerBody(JSON.parse(String(init.body)));
        } catch {
          // ignore — body inspection is best-effort
        }
      }
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: {
          "content-type": "audio/wav",
          "x-octomil-voice": "af_bella",
        },
      });
    }
    return new Response(`unexpected url ${url}`, { status: 500 });
  });
  return {
    fetchMock,
    get runnerCalls() {
      return runnerCalls;
    },
  } as unknown as { fetchMock: ReturnType<typeof vi.fn>; runnerCalls: number };
}

describe("client.warmup({capability:'tts'})", () => {
  it("warmup runs prepare end-to-end and stores the loaded backend on the client", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "runner_token";
    const bytes = Buffer.from("warmup test model bytes");
    const cacheRoot = path.join(tmpRoot, "cache");
    const captured: { plan?: Record<string, unknown>; runner: Record<string, unknown>[] } = {
      runner: [],
    };
    const built = buildFetchMock(bytes, {
      digest: sha256(bytes),
      requiredFiles: ["kokoro.onnx"],
      appSlug: "tts-tester",
      runnerUrl: "http://127.0.0.1:5151/v1/audio/speech",
      onRunnerBody: (body) => captured.runner.push(body),
      capturePlanRequest: (body) => {
        captured.plan = body;
      },
    });
    globalThis.fetch = built.fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      cacheRoot,
    });
    await client.initialize();

    const warmup = await client.warmup({
      model: "@app/tts-tester/tts",
      capability: "tts",
      policy: "private",
      app: "tts-tester",
    });

    // Prepare actually materialized bytes.
    expect(warmup.prepare.prepared).toBe(true);
    expect(warmup.prepare.modelDir).toBeTruthy();
    expect(warmup.prepare.primaryPath).toBeTruthy();
    expect(warmup.backendLoaded).toBe(true);
    // Backend handle is cached on the client.
    const handle = client.getWarmedBackend("tts", "@app/tts-tester/tts");
    expect(handle?.loaded).toBe(true);
    expect(handle?.modelDir).toBe(warmup.prepare.modelDir);
    expect(handle?.digest).toBe(warmup.prepare.digest);
  });

  it("reuses warmed backend on second create", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "runner_token";
    const bytes = Buffer.from("warmup model bytes for reuse test");
    const cacheRoot = path.join(tmpRoot, "cache");
    const captured: { runner: Record<string, unknown>[] } = { runner: [] };
    const built = buildFetchMock(bytes, {
      digest: sha256(bytes),
      requiredFiles: ["kokoro.onnx"],
      appSlug: "tts-tester",
      runnerUrl: "http://127.0.0.1:5151/v1/audio/speech",
      onRunnerBody: (body) => captured.runner.push(body),
      capturePlanRequest: () => {},
    });
    globalThis.fetch = built.fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      cacheRoot,
    });
    await client.initialize();

    await client.warmup({
      model: "@app/tts-tester/tts",
      capability: "tts",
      policy: "private",
      app: "tts-tester",
    });
    const beforeCreate = client.getWarmedBackend("tts", "@app/tts-tester/tts");
    expect(beforeCreate?.loaded).toBe(true);

    const response = await client.audio.speech.create({
      model: "@app/tts-tester/tts",
      input: "hello world",
      voice: "af_bella",
      policy: "private",
      app: "tts-tester",
    });
    // The warmed handle's engine string flows into the route metadata
    // — that is the cross-SDK signal that the create call dispatched
    // against the warmed state. Per the warmup contract, the engine
    // id matches the handle (or its `:soft-warm` variant when ONNX
    // isn't installed in the test env).
    expect(response.route.locality).toBe("on_device");
    expect(response.route.engine).toBe(beforeCreate?.engine);
    expect(response.route.engine === "sherpa-onnx" || response.route.engine === "sherpa-onnx:soft-warm").toBe(true);
    // The runner call body included the warm `model_dir` so the
    // runner can short-circuit re-loading.
    expect(captured.runner).toHaveLength(1);
    expect(captured.runner[0]?.warm_model_dir).toBe(beforeCreate?.modelDir);
    // Same handle, no re-warm — confirmed by reading the cache pointer.
    const afterCreate = client.getWarmedBackend("tts", "@app/tts-tester/tts");
    expect(afterCreate).toBe(beforeCreate);
  });

  it("warmup loads backend into reusable state — releaseWarmedBackends drops the handle", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "runner_token";
    const bytes = Buffer.from("release test bytes");
    const cacheRoot = path.join(tmpRoot, "cache");
    const built = buildFetchMock(bytes, {
      digest: sha256(bytes),
      requiredFiles: ["kokoro.onnx"],
      appSlug: "tts-tester",
      runnerUrl: "http://127.0.0.1:5151/v1/audio/speech",
      onRunnerBody: () => {},
      capturePlanRequest: () => {},
    });
    globalThis.fetch = built.fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      cacheRoot,
    });
    await client.initialize();

    await client.warmup({
      model: "@app/tts-tester/tts",
      capability: "tts",
      policy: "private",
      app: "tts-tester",
    });
    expect(client.getWarmedBackend("tts", "@app/tts-tester/tts")).toBeTruthy();
    client.releaseWarmedBackends();
    expect(client.getWarmedBackend("tts", "@app/tts-tester/tts")).toBeUndefined();
  });
});
