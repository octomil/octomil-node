/**
 * Transcription prepare + warmup contract tests.
 *
 * Pin the transcription lifecycle invariants:
 *   - `client.prepare({capability:'transcription'})` materializes
 *     bytes via the same DurableDownloader + Materializer pipeline
 *     as TTS, with the same digest + path-safety guarantees.
 *   - `client.warmup({capability:'transcription'})` runs prepare
 *     end-to-end and stores a BackendHandle on the client.
 *   - The next `audio.transcriptions.create` consumes the prepared
 *     `model_dir`: the runner request body carries `warm_model_dir`
 *     so the runner can short-circuit re-loading.
 *
 * Mirrors Python `client.prepare(capability='transcription')` and
 * `client.warmup(capability='transcription')`.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Octomil } from "../src/facade.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "octomil-trx-prep-"));
});

afterEach(async () => {
  delete process.env.OCTOMIL_LOCAL_RUNNER_URL;
  delete process.env.OCTOMIL_LOCAL_RUNNER_TOKEN;
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function sha256(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

describe("client.prepare({capability:'transcription'})", () => {
  it("materializes a transcription artifact with digest verification", async () => {
    const bytes = Buffer.from("whisper model bytes");
    const cacheRoot = path.join(tmpRoot, "cache");
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        return new Response(
          JSON.stringify({
            model: "@app/transcribe-app/transcription",
            capability: "transcription",
            policy: "private",
            candidates: [
              {
                locality: "local",
                engine: "whisper",
                priority: 0,
                confidence: 1,
                reason: "private",
                delivery_mode: "sdk_runtime",
                prepare_required: true,
                prepare_policy: "lazy",
                artifact: {
                  model_id: "whisper-tiny-en",
                  artifact_id: "whisper-tiny-en",
                  digest: sha256(bytes),
                  download_urls: [{ url: "https://cdn.example/whisper.bin" }],
                  required_files: ["whisper.bin"],
                },
              },
            ],
            fallback_allowed: false,
            app_resolution: {
              app_slug: "transcribe-app",
              selected_model: "whisper-tiny-en",
              routing_policy: "private",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://cdn.example/whisper.bin") {
        return new Response(bytes, { status: 200 });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      cacheRoot,
    });
    await client.initialize();
    const outcome = await client.prepare({
      model: "@app/transcribe-app/transcription",
      capability: "transcription",
      app: "transcribe-app",
      policy: "private",
    });
    expect(outcome.prepared).toBe(true);
    expect(outcome.modelDir).toBeTruthy();
    expect(outcome.primaryPath?.endsWith("whisper.bin")).toBe(true);
    const onDisk = await fsp.readFile(outcome.primaryPath!);
    expect(onDisk.equals(bytes)).toBe(true);
  });
});

describe("client.warmup({capability:'transcription'})", () => {
  it("warmup runs prepare and the next transcription create reuses the warmed model_dir", async () => {
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";
    const bytes = Buffer.from("warmed whisper model bytes");
    const cacheRoot = path.join(tmpRoot, "cache");
    const captured: { runnerWarmModelDirs: string[] } = { runnerWarmModelDirs: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v2/runtime/plan")) {
        return new Response(
          JSON.stringify({
            model: "@app/transcribe-app/transcription",
            capability: "transcription",
            policy: "private",
            candidates: [
              {
                locality: "local",
                engine: "whisper",
                priority: 0,
                confidence: 1,
                reason: "private",
                delivery_mode: "sdk_runtime",
                prepare_required: true,
                prepare_policy: "lazy",
                artifact: {
                  model_id: "whisper-tiny-en",
                  artifact_id: "whisper-tiny-en",
                  digest: sha256(bytes),
                  download_urls: [{ url: "https://cdn.example/whisper.bin" }],
                  required_files: ["whisper.bin"],
                },
              },
            ],
            fallback_allowed: false,
            app_resolution: {
              app_slug: "transcribe-app",
              selected_model: "whisper-tiny-en",
              routing_policy: "private",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "https://cdn.example/whisper.bin") {
        return new Response(bytes, { status: 200 });
      }
      if (url === "http://127.0.0.1:5151/v1/audio/transcriptions") {
        // multipart body — extract `warm_model_dir` field if present.
        const form = init?.body as FormData | undefined;
        if (form && typeof form.entries === "function") {
          for (const [key, val] of form.entries()) {
            if (key === "warm_model_dir" && typeof val === "string") {
              captured.runnerWarmModelDirs.push(val);
            }
          }
        }
        return new Response(JSON.stringify({ text: "transcribed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(`unexpected ${url}`, { status: 500 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const client = await Octomil.local({});
    await client.initialize();

    // Build a hosted-style instance for warmup (warmup needs the
    // planner client; local-only Octomil has no planner). Reuse the
    // env-derived local runner endpoint by also constructing a
    // hosted+planner client.
    const hostedClient = new Octomil({
      apiKey: "edg_sk_abc",
      orgId: "org_1",
      serverUrl: "https://api.test.com",
      cacheRoot,
    });
    await hostedClient.initialize();
    const warmup = await hostedClient.warmup({
      model: "@app/transcribe-app/transcription",
      capability: "transcription",
      policy: "private",
      app: "transcribe-app",
    });
    expect(warmup.prepare.prepared).toBe(true);
    expect(warmup.backendLoaded).toBe(true);

    // Bridge the warm handle into the local client by sharing the
    // cacheRoot — the model_dir is stable across instances when the
    // cacheRoot + artifact_id match. Since the test exercises the
    // honest "local-runner consumes warm dir" contract, we store the
    // handle directly on the local client too. (In production, the
    // same client typically does both warmup and create.)
    const handle = hostedClient.getWarmedBackend(
      "transcription",
      "@app/transcribe-app/transcription",
    );
    expect(handle).toBeTruthy();

    // Now exercise the local client's transcription create with the
    // same model — we need the same client instance for the warm
    // cache lookup. Use hostedClient with a configured local runner
    // endpoint env var instead.
    process.env.OCTOMIL_LOCAL_RUNNER_URL = "http://127.0.0.1:5151";
    process.env.OCTOMIL_LOCAL_RUNNER_TOKEN = "tok";

    // Hosted client doesn't expose audio.transcriptions in non-local
    // mode. The warm-handle reuse is tested via local() client; copy
    // the warm handle into a fresh local client to cover the runner
    // request-body contract.
    const localClient = await Octomil.local({});
    await localClient.initialize();
    // Stash the same handle on the local client so `audio.transcriptions.create`
    // sees a warm `model_dir`.
    (localClient as unknown as { _warmHandles: Map<string, unknown> })._warmHandles.set(
      `transcription:@app/transcribe-app/transcription`,
      handle!,
    );
    await localClient.audio.transcriptions.create({
      model: "@app/transcribe-app/transcription",
      audio: new Uint8Array([1, 2, 3]),
      app: "transcribe-app",
      policy: "private",
    });
    expect(captured.runnerWarmModelDirs).toEqual([handle!.modelDir]);
  });
});
