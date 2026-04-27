/**
 * Reviewer P1 regressions:
 *
 *   1. ``safeJoin`` must refuse paths that traverse a pre-existing
 *      symlink whose target escapes the artifact directory.
 *   2. ``prepareForFacade`` (and via the facade, ``client.prepare``)
 *      must materialize bytes when given a materializer, with
 *      ``mode: 'explicit'`` so ``prepare_policy === "explicit_only"``
 *      candidates are admitted.
 *   3. ``PrepareManager.prepare`` honors the explicit-only policy
 *      under ``PrepareMode.EXPLICIT``.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeJoin } from "../src/prepare/durable-download.js";
import { PrepareManager, PrepareMode } from "../src/prepare/prepare-manager.js";
import { prepareForFacade } from "../src/prepare/prepare.js";
import { OctomilError } from "../src/types.js";
import type { RuntimePlannerClient } from "../src/planner/client.js";
import type { RuntimePlanResponse } from "../src/planner/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "octomil-prep-p1-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function sha256Hex(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

describe("safeJoin — symlink containment (P1)", () => {
  it("refuses paths whose ancestor symlink escapes destDir", async () => {
    const destDir = path.join(tmpDir, "artifact");
    await fs.mkdir(destDir);
    const outside = path.join(tmpDir, "outside");
    await fs.mkdir(outside);
    // Plant a symlink inside destDir that targets a directory
    // outside. Without the fix, ``safeJoin(destDir, 'linkdir/x.bin')``
    // returns a path under destDir lexically, but a subsequent
    // ``rename`` follows the symlink and writes to /tmp/outside/x.bin.
    await fs.symlink(outside, path.join(destDir, "linkdir"));
    expect(() => safeJoin(destDir, "linkdir/escaped.txt")).toThrow(OctomilError);
    expect(() => safeJoin(destDir, "linkdir/escaped.txt")).toThrow(
      /resolves outside|symlink/i,
    );
  });

  it("accepts safe paths under a non-symlinked destDir", async () => {
    const destDir = path.join(tmpDir, "artifact");
    await fs.mkdir(destDir);
    expect(() => safeJoin(destDir, "model.onnx")).not.toThrow();
  });
});

describe("PrepareManager.prepare — explicit_only policy (P1)", () => {
  function makeFetch(payload: Buffer, url: string): typeof fetch {
    return (async (input: RequestInfo | URL): Promise<Response> => {
      const incoming =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (incoming !== url) return new Response(null, { status: 404 });
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
  }

  it("rejects an explicit_only candidate under PrepareMode.LAZY", async () => {
    const cacheDir = path.join(tmpDir, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const pm = new PrepareManager({ cacheDir });
    await expect(
      pm.prepare(
        {
          locality: "local",
          priority: 0,
          confidence: 1,
          reason: "test",
          engine: "sherpa-onnx",
          artifact: {
            model_id: "kokoro-82m",
            artifact_id: "kokoro-82m",
            digest: "sha256:" + "0".repeat(64),
            download_urls: [{ url: "https://cdn.example.com/" }],
          },
          delivery_mode: "sdk_runtime",
          prepare_required: true,
          prepare_policy: "explicit_only",
        } as never,
        { mode: PrepareMode.LAZY },
      ),
    ).rejects.toThrow(/explicit_only/);
  });

  it("admits an explicit_only candidate under PrepareMode.EXPLICIT", async () => {
    const payload = Buffer.from("explicit prepare bytes");
    const url = "https://cdn.example.com/x";
    const cacheDir = path.join(tmpDir, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const pm = new PrepareManager({ cacheDir, downloaderOptions: { fetchImpl: makeFetch(payload, url) } });
    const outcome = await pm.prepare(
      {
        locality: "local",
        priority: 0,
        confidence: 1,
        reason: "test",
        engine: "sherpa-onnx",
        artifact: {
          model_id: "kokoro-82m",
          artifact_id: "kokoro-82m",
          digest: sha256Hex(payload),
          download_urls: [{ url }],
        },
        delivery_mode: "sdk_runtime",
        prepare_required: true,
        prepare_policy: "explicit_only",
      } as never,
      { mode: PrepareMode.EXPLICIT },
    );
    expect(outcome.cached).toBe(false);
    const written = await fs.readFile(outcome.files[""]!);
    expect(written.equals(payload)).toBe(true);
  });
});

describe("prepareForFacade — materializer integration (P1)", () => {
  it("calls the materializer with mode='explicit' so explicit_only candidates work", async () => {
    let observedMode: string | undefined;
    const fakeMaterializer = {
      prepare: async (_candidate: unknown, options: { mode: "lazy" | "explicit" }) => {
        observedMode = options.mode;
        return { artifactDir: path.join(tmpDir, "fake-artifact"), files: { "": "/fake/file" } };
      },
    };
    const planner: RuntimePlannerClient = {
      fetchPlan: async (): Promise<RuntimePlanResponse> => ({
        ttl_seconds: 300,
        candidates: [
          {
            locality: "local",
            priority: 0,
            confidence: 1,
            reason: "test",
            engine: "sherpa-onnx",
            artifact: {
              model_id: "kokoro-82m",
              artifact_id: "kokoro-82m",
              digest: "sha256:" + "a".repeat(64),
              download_urls: [{ url: "https://cdn.example.com/" }],
            },
            delivery_mode: "sdk_runtime",
            prepare_required: true,
            prepare_policy: "explicit_only",
          },
        ],
      }),
    } as unknown as RuntimePlannerClient;

    const outcome = await prepareForFacade(planner, {
      model: "kokoro-82m",
      capability: "tts",
      materializer: fakeMaterializer,
    });
    expect(observedMode).toBe("explicit");
    expect(outcome.prepared).toBe(true);
    expect(outcome.artifactDir).toBe(path.join(tmpDir, "fake-artifact"));
  });

  it("end-to-end: prepareForFacade + real PrepareManager downloads bytes and writes files", async () => {
    const payload = Buffer.from("the quick brown fox jumps over the lazy dog");
    const url = "https://cdn.example.com/k.tar.bz2";
    const cacheDir = path.join(tmpDir, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const incoming =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (incoming !== url) return new Response(null, { status: 404 });
      return new Response(payload, { status: 200 });
    }) as typeof fetch;
    const pm = new PrepareManager({ cacheDir, downloaderOptions: { fetchImpl } });
    const planner: RuntimePlannerClient = {
      fetchPlan: async (): Promise<RuntimePlanResponse> => ({
        ttl_seconds: 300,
        candidates: [
          {
            locality: "local",
            priority: 0,
            confidence: 1,
            reason: "test",
            engine: "sherpa-onnx",
            artifact: {
              model_id: "kokoro-82m",
              artifact_id: "kokoro-82m",
              digest: sha256Hex(payload),
              download_urls: [{ url }],
            },
            delivery_mode: "sdk_runtime",
            prepare_required: true,
            prepare_policy: "lazy",
          },
        ],
      }),
    } as unknown as RuntimePlannerClient;

    const outcome = await prepareForFacade(planner, {
      model: "kokoro-82m",
      capability: "tts",
      materializer: pm,
    });
    expect(outcome.prepared).toBe(true);
    expect(outcome.artifactDir).toBeDefined();
    expect(outcome.files).toBeDefined();
    const written = await fs.readFile(outcome.files![""]!);
    expect(written.equals(payload)).toBe(true);
  });
});
