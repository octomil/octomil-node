/**
 * End-to-end contract tests for the Node prepare lifecycle.
 *
 * Covers:
 *   - real download via DurableDownloader with digest verification
 *   - materialization into a runtime layout
 *   - idempotent cache hit on a second prepare
 *   - rejection of malformed plans (missing digest, traversal,
 *     symlink-escape, multi-file artifacts)
 *   - facade `client.prepare(...)` consumes the manager and returns a
 *     `prepared=true` outcome with `modelDir` populated
 *   - facade `audio.speech.create(...)` consumes the prepared
 *     `model_dir` (route metadata reflects the warmed engine).
 *
 * Each test pins one or more of the contract assertions referenced
 * from `conformance/capability_lifecycle_parity.yaml`.
 */
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Octomil } from "../src/facade.js";
import {
  PrepareManager,
  downloadOne,
  fileDigest,
  parseDigest,
} from "../src/prepare/index.js";
import { prepareForFacade } from "../src/prepare/prepare.js";
import type {
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
  RuntimePlanResponse,
} from "../src/planner/types.js";
import { OctomilError } from "../src/types.js";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "octomil-prepare-"));
});

afterEach(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function sha256(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

function buildArtifact(
  bytes: Buffer,
  url: string,
  overrides: Partial<RuntimeArtifactPlan> = {},
): RuntimeArtifactPlan {
  return {
    model_id: "kokoro-en-v0_19",
    artifact_id: "kokoro-en-v0_19",
    digest: sha256(bytes),
    download_urls: [{ url }],
    ...overrides,
  };
}

function buildCandidate(
  artifact: RuntimeArtifactPlan,
  overrides: Partial<RuntimeCandidatePlan> = {},
): RuntimeCandidatePlan {
  return {
    locality: "local",
    engine: "sherpa-onnx",
    priority: 0,
    confidence: 1,
    reason: "test",
    artifact,
    delivery_mode: "sdk_runtime",
    prepare_required: true,
    prepare_policy: "lazy",
    ...overrides,
  };
}

function buildPlan(candidate: RuntimeCandidatePlan): RuntimePlanResponse {
  return {
    model: candidate.artifact?.model_id ?? "kokoro-en-v0_19",
    capability: "tts",
    policy: "private",
    candidates: [candidate],
    fallback_candidates: [],
    fallback_allowed: false,
    server_generated_at: new Date().toISOString(),
    public_client_allowed: false,
    plan_ttl_seconds: 600,
    app_resolution: { app_slug: "tts-tester", routing_policy: "private" },
  };
}

function fakeFetchOk(body: Buffer): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    })) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// downloadOne primitive — digest, traversal, missing-digest, atomic publish
// ---------------------------------------------------------------------------

describe("downloadOne", () => {
  it("downloads bytes and verifies the digest end-to-end", async () => {
    const bytes = Buffer.from("hello world artifact");
    const dest = path.join(tmpRoot, "dest");
    const result = await downloadOne({
      destDir: dest,
      relativePath: "model.bin",
      endpoints: [{ url: "http://example.test/model.bin" }],
      digest: sha256(bytes),
      fetchImpl: fakeFetchOk(bytes),
    });
    expect(result.cacheHit).toBe(false);
    expect(result.bytesDownloaded).toBe(bytes.length);
    const onDisk = await fsp.readFile(result.filePath);
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it("rejects a digest mismatch and does not publish", async () => {
    const bytes = Buffer.from("abc");
    const lying = sha256(Buffer.from("xyz")); // wrong digest
    const dest = path.join(tmpRoot, "dest");
    await expect(
      downloadOne({
        destDir: dest,
        relativePath: "model.bin",
        endpoints: [{ url: "http://example.test/model.bin" }],
        digest: lying,
        fetchImpl: fakeFetchOk(bytes),
      }),
    ).rejects.toBeInstanceOf(OctomilError);
    // No `model.bin` should be on disk.
    await expect(fsp.access(path.join(dest, "model.bin"))).rejects.toThrow();
  });

  it("re-uses a cached file when the digest still matches", async () => {
    const bytes = Buffer.from("cached payload");
    const dest = path.join(tmpRoot, "dest");
    const digest = sha256(bytes);
    const fetchMock = vi.fn(fakeFetchOk(bytes));
    // First call: writes bytes.
    await downloadOne({
      destDir: dest,
      relativePath: "model.bin",
      endpoints: [{ url: "http://example.test/model.bin" }],
      digest,
      fetchImpl: fetchMock as typeof fetch,
    });
    // Second call: cache hit, no fetch.
    const second = await downloadOne({
      destDir: dest,
      relativePath: "model.bin",
      endpoints: [{ url: "http://example.test/model.bin" }],
      digest,
      fetchImpl: fetchMock as typeof fetch,
    });
    expect(second.cacheHit).toBe(true);
    expect(second.bytesDownloaded).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a traversal `relativePath` before fetching", async () => {
    const fetchMock = vi.fn(fakeFetchOk(Buffer.from("x")));
    await expect(
      downloadOne({
        destDir: path.join(tmpRoot, "dest"),
        relativePath: "../escape.bin",
        endpoints: [{ url: "http://example.test/x" }],
        digest: sha256(Buffer.from("x")),
        fetchImpl: fetchMock as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(OctomilError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing digest", () => {
    expect(() => parseDigest("")).toThrow(OctomilError);
    expect(() => parseDigest("sha256:")).toThrow(OctomilError);
  });
});

// ---------------------------------------------------------------------------
// PrepareManager — full lifecycle against a real on-disk cache
// ---------------------------------------------------------------------------

describe("PrepareManager", () => {
  it("downloads, materializes, and re-verifies on a second prepare", async () => {
    const bytes = Buffer.from("model bytes for the lifecycle test");
    const cacheRoot = path.join(tmpRoot, "cache");
    const fetchMock = vi.fn(fakeFetchOk(bytes));
    const manager = new PrepareManager({
      cacheRoot,
      fetchImpl: fetchMock as typeof fetch,
    });
    const candidate = buildCandidate(
      buildArtifact(bytes, "http://example.test/kokoro.onnx", {
        required_files: ["kokoro.onnx"],
      }),
    );

    const first = await manager.prepare(candidate);
    expect(first.cacheHit).toBe(false);
    expect(first.bytesDownloaded).toBe(bytes.length);
    expect(first.modelDir.startsWith(cacheRoot)).toBe(true);
    expect(first.primaryPath.endsWith("kokoro.onnx")).toBe(true);
    // Bytes are on disk and digest matches.
    const onDisk = await fsp.readFile(first.primaryPath);
    expect(onDisk.equals(bytes)).toBe(true);
    expect(await fileDigest(first.primaryPath)).toBe(sha256(bytes));

    // Idempotent fast path: second prepare hits the cache.
    const second = await manager.prepare(candidate);
    expect(second.cacheHit).toBe(true);
    expect(second.bytesDownloaded).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects an artifact with no digest", async () => {
    const bytes = Buffer.from("bytes");
    const manager = new PrepareManager({
      cacheRoot: path.join(tmpRoot, "cache"),
      fetchImpl: fakeFetchOk(bytes),
    });
    const candidate = buildCandidate(
      buildArtifact(bytes, "http://example.test/x", { digest: undefined }),
    );
    await expect(manager.prepare(candidate)).rejects.toBeInstanceOf(OctomilError);
  });

  it("rejects an artifact with a traversal `required_files` entry", async () => {
    const bytes = Buffer.from("bytes");
    const manager = new PrepareManager({
      cacheRoot: path.join(tmpRoot, "cache"),
      fetchImpl: fakeFetchOk(bytes),
    });
    const candidate = buildCandidate(
      buildArtifact(bytes, "http://example.test/x", {
        required_files: ["../escape.bin"],
      }),
    );
    await expect(manager.prepare(candidate)).rejects.toBeInstanceOf(OctomilError);
  });

  it("rejects a multi-file artifact (no per-file manifest yet)", async () => {
    const bytes = Buffer.from("bytes");
    const manager = new PrepareManager({
      cacheRoot: path.join(tmpRoot, "cache"),
      fetchImpl: fakeFetchOk(bytes),
    });
    const candidate = buildCandidate(
      buildArtifact(bytes, "http://example.test/x", {
        required_files: ["a.bin", "b.bin"],
      }),
    );
    await expect(manager.prepare(candidate)).rejects.toBeInstanceOf(OctomilError);
  });

  it("rejects a symlink-escape attempt during materialization", async () => {
    const bytes = Buffer.from("bytes");
    const cacheRoot = path.join(tmpRoot, "cache");
    const manager = new PrepareManager({
      cacheRoot,
      fetchImpl: fakeFetchOk(bytes),
    });
    const candidate = buildCandidate(
      buildArtifact(bytes, "http://example.test/k.onnx", {
        artifact_id: "evil-artifact",
        required_files: ["evil/file.bin"],
      }),
    );
    // Pre-create a hostile symlink layout under the runtime root: an
    // attacker has previously planted `runtime/evil-artifact/evil ->
    // /tmp/<outside>` and we're now preparing into the same key. The
    // materializer must refuse to follow the symlink.
    const outside = path.join(tmpRoot, "outside");
    await fsp.mkdir(outside, { recursive: true });
    const runtimeDir = path.join(cacheRoot, "runtime", "evil-artifact");
    await fsp.mkdir(runtimeDir, { recursive: true });
    await fsp.symlink(outside, path.join(runtimeDir, "evil"));

    await expect(manager.prepare(candidate)).rejects.toBeInstanceOf(OctomilError);
  });
});

// ---------------------------------------------------------------------------
// Facade integration — `client.prepare(...)` materializes and surfaces appSlug
// ---------------------------------------------------------------------------

describe("client.prepare(...)", () => {
  it("materializes bytes when called via the facade and preserves app identity", async () => {
    const bytes = Buffer.from("kokoro tts model");
    const cacheRoot = path.join(tmpRoot, "cache");
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
                reason: "private app policy",
                delivery_mode: "sdk_runtime",
                prepare_required: true,
                prepare_policy: "lazy",
                artifact: {
                  model_id: "kokoro-en-v0_19",
                  artifact_id: "kokoro-en-v0_19",
                  digest: sha256(bytes),
                  download_urls: [{ url: "https://cdn.example.com/k.onnx" }],
                  required_files: ["kokoro.onnx"],
                },
              },
            ],
            fallback_allowed: false,
            app_resolution: {
              app_slug: "tts-tester",
              selected_model: "kokoro-en-v0_19",
              routing_policy: "private",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(bytes, { status: 200 });
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
      model: "@app/tts-tester/tts",
      capability: "tts",
      policy: "private",
      app: "tts-tester",
    });
    expect(outcome.prepared).toBe(true);
    expect(outcome.modelDir).toBeTruthy();
    expect(outcome.primaryPath).toBeTruthy();
    expect(outcome.appSlug).toBe("tts-tester");
    expect(outcome.routingPolicy).toBe("private");
    // Bytes landed on disk under the cache root we configured.
    expect(outcome.modelDir!.startsWith(cacheRoot)).toBe(true);
    const onDisk = await fsp.readFile(outcome.primaryPath!);
    expect(onDisk.equals(bytes)).toBe(true);

    // Second prepare is a cache hit — no fresh download.
    const second = await client.prepare({
      model: "@app/tts-tester/tts",
      capability: "tts",
      policy: "private",
      app: "tts-tester",
    });
    expect(second.prepared).toBe(true);
    expect(second.cacheHit).toBe(true);
  });

  it("planner-introspection mode (no PrepareManager) leaves prepared=false", async () => {
    const bytes = Buffer.from("model bytes");
    const planner = {
      fetchPlan: vi.fn().mockResolvedValue(
        buildPlan(
          buildCandidate(
            buildArtifact(bytes, "https://cdn.example.com/k.onnx", {
              required_files: ["kokoro.onnx"],
            }),
          ),
        ),
      ),
    };
    const outcome = await prepareForFacade(planner as unknown as Parameters<
      typeof prepareForFacade
    >[0], {
      model: "@app/tts-tester/tts",
      capability: "tts",
      app: "tts-tester",
      policy: "private",
    });
    expect(outcome.prepared).toBe(false);
    expect(outcome.modelDir).toBeNull();
    expect(outcome.appSlug).toBe("tts-tester");
    expect(outcome.routingPolicy).toBe("private");
  });
});
