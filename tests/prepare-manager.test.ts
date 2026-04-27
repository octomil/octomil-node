/**
 * Tests for ``src/prepare/prepare-manager.ts`` — the orchestration
 * layer above ``DurableDownloader``. Mirrors a subset of Python's
 * ``tests/test_prepare_manager.py`` invariants so the Node and Python
 * SDKs reject and accept the same planner candidates.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PrepareManager,
  PrepareMode,
  validateForPrepare,
} from "../src/prepare/prepare-manager.js";
import type { RuntimeCandidatePlan } from "../src/planner/types.js";
import { OctomilError } from "../src/types.js";
import { safeFilesystemKey } from "../src/prepare/fs-key.js";

let tmpDir: string;
let cacheDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "octomil-pm-"));
  cacheDir = path.join(tmpDir, "cache");
  await fs.mkdir(cacheDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function sha256Hex(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function makeFetch(responses: Map<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const factory = responses.get(url);
    if (!factory) return new Response(null, { status: 404 });
    return factory();
  }) as typeof fetch;
}

function makeCandidate(overrides: Partial<RuntimeCandidatePlan> = {}): RuntimeCandidatePlan {
  return {
    locality: "local",
    priority: 0,
    confidence: 0.9,
    reason: "test",
    engine: "sherpa-onnx",
    artifact: {
      model_id: "kokoro-82m",
      artifact_id: "kokoro-82m",
      digest: "sha256:" + "0".repeat(64),
      download_urls: [{ url: "https://cdn.example.com/" }],
      ...overrides.artifact,
    },
    delivery_mode: "sdk_runtime",
    prepare_required: true,
    prepare_policy: "lazy",
    ...overrides,
  } as RuntimeCandidatePlan;
}

describe("validateForPrepare", () => {
  it("accepts a well-formed local sdk_runtime candidate", () => {
    expect(() => validateForPrepare(makeCandidate())).not.toThrow();
  });

  it("rejects non-local candidates", () => {
    expect(() =>
      validateForPrepare(makeCandidate({ locality: "cloud" })),
    ).toThrow(/locality/);
  });

  it("rejects non-sdk_runtime delivery", () => {
    expect(() =>
      validateForPrepare(makeCandidate({ delivery_mode: "hosted_gateway" })),
    ).toThrow(/delivery_mode/);
  });

  it("rejects prepare_policy=disabled", () => {
    expect(() =>
      validateForPrepare(makeCandidate({ prepare_policy: "disabled" })),
    ).toThrow(/disabled/);
  });

  it("skips artifact validation when prepare_required=false", () => {
    expect(() =>
      validateForPrepare(
        makeCandidate({
          prepare_required: false,
          artifact: { model_id: "test" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects missing digest when prepare_required=true", () => {
    const c = makeCandidate();
    c.artifact = { ...c.artifact!, digest: undefined };
    expect(() => validateForPrepare(c)).toThrow(/digest/);
  });

  it("rejects empty download_urls when prepare_required=true", () => {
    const c = makeCandidate();
    c.artifact = { ...c.artifact!, download_urls: [] };
    expect(() => validateForPrepare(c)).toThrow(/download_urls/);
  });

  it("rejects multi-file required_files (manifest_uri not yet supported)", () => {
    const c = makeCandidate();
    c.artifact = { ...c.artifact!, required_files: ["a.bin", "b.bin"] };
    expect(() => validateForPrepare(c)).toThrow(/manifest_uri/);
  });

  it("rejects empty artifact_id", () => {
    const c = makeCandidate();
    c.artifact = { model_id: "", artifact_id: "", digest: "sha256:" + "0".repeat(64), download_urls: [{ url: "x" }] };
    expect(() => validateForPrepare(c)).toThrow(/artifact_id/);
  });

  it("rejects NUL byte in artifact_id", () => {
    const c = makeCandidate();
    c.artifact = { ...c.artifact!, artifact_id: "kokoro\u0000bomb" };
    expect(() => validateForPrepare(c)).toThrow(/NUL byte/);
  });
});

describe("PrepareManager.canPrepare", () => {
  it("returns true for a well-formed candidate", () => {
    const pm = new PrepareManager({ cacheDir });
    expect(pm.canPrepare(makeCandidate())).toBe(true);
  });

  it("returns false for a synthetic candidate (no urls)", () => {
    const pm = new PrepareManager({ cacheDir });
    const c = makeCandidate();
    c.artifact = { ...c.artifact!, download_urls: [] };
    expect(pm.canPrepare(c)).toBe(false);
  });

  it("never throws on malformed input — returns false instead", () => {
    const pm = new PrepareManager({ cacheDir });
    const c = makeCandidate();
    c.artifact = { ...c.artifact!, digest: undefined };
    expect(pm.canPrepare(c)).toBe(false);
  });
});

describe("PrepareManager.artifactDirFor", () => {
  it("derives the same directory shape Python uses", () => {
    const pm = new PrepareManager({ cacheDir });
    const dir = pm.artifactDirFor("kokoro-82m");
    // Cross-SDK conformance: Python's safe_filesystem_key produces
    // "kokoro-82m-64e5b12f9efb"; both SDKs land artifacts at the
    // same on-disk location for the same id.
    expect(path.basename(dir)).toBe("kokoro-82m-64e5b12f9efb");
    expect(path.basename(dir)).toBe(safeFilesystemKey("kokoro-82m"));
  });

  it("rejects empty artifact_id", () => {
    const pm = new PrepareManager({ cacheDir });
    expect(() => pm.artifactDirFor("")).toThrow(OctomilError);
  });

  it("rejects NUL byte in artifact_id", () => {
    const pm = new PrepareManager({ cacheDir });
    expect(() => pm.artifactDirFor("foo\u0000bar")).toThrow(OctomilError);
  });
});

describe("PrepareManager.prepare", () => {
  it("downloads + verifies a single-file artifact end-to-end", async () => {
    const payload = Buffer.from("kokoro tarball bytes");
    const url = "https://cdn.example.com/kokoro.tar.bz2";
    const fetchImpl = makeFetch(new Map([[url, () => new Response(payload, { status: 200 })]]));
    const pm = new PrepareManager({ cacheDir, downloaderOptions: { fetchImpl } });
    const c = makeCandidate();
    c.artifact = {
      ...c.artifact!,
      digest: sha256Hex(payload),
      download_urls: [{ url }],
    };
    const outcome = await pm.prepare(c);
    expect(outcome.cached).toBe(false);
    expect(outcome.artifactDir).toBe(pm.artifactDirFor("kokoro-82m"));
    expect(outcome.files[""]).toBeDefined();
    const written = await fs.readFile(outcome.files[""]!);
    expect(written.equals(payload)).toBe(true);
  });

  it("returns cached=true when the artifact already exists + verifies", async () => {
    const payload = Buffer.from("already on disk");
    const fetchImpl = makeFetch(new Map([["https://cdn.example.com/x", () => new Response(payload, { status: 200 })]]));
    const pm = new PrepareManager({ cacheDir, downloaderOptions: { fetchImpl } });
    const c = makeCandidate();
    c.artifact = {
      ...c.artifact!,
      digest: sha256Hex(payload),
      download_urls: [{ url: "https://cdn.example.com/x" }],
    };

    // First call materializes; second should hit the cache.
    await pm.prepare(c);
    const outcome = await pm.prepare(c);
    expect(outcome.cached).toBe(true);
    const written = await fs.readFile(outcome.files[""]!);
    expect(written.equals(payload)).toBe(true);
  });

  it("refuses prepare_policy='explicit_only' under PrepareMode.LAZY", async () => {
    const pm = new PrepareManager({ cacheDir });
    const c = makeCandidate({ prepare_policy: "explicit_only" });
    await expect(pm.prepare(c, { mode: PrepareMode.LAZY })).rejects.toThrow(/explicit_only/);
  });

  it("admits prepare_policy='explicit_only' under PrepareMode.EXPLICIT", async () => {
    const payload = Buffer.from("explicit prepare bytes");
    const fetchImpl = makeFetch(
      new Map([["https://cdn.example.com/x", () => new Response(payload, { status: 200 })]]),
    );
    const pm = new PrepareManager({ cacheDir, downloaderOptions: { fetchImpl } });
    const c = makeCandidate({ prepare_policy: "explicit_only" });
    c.artifact = {
      ...c.artifact!,
      digest: sha256Hex(payload),
      download_urls: [{ url: "https://cdn.example.com/x" }],
    };
    const outcome = await pm.prepare(c, { mode: PrepareMode.EXPLICIT });
    expect(outcome.cached).toBe(false);
  });

  it("returns no-op outcome when prepare_required=false", async () => {
    const pm = new PrepareManager({ cacheDir });
    const c = makeCandidate({ prepare_required: false });
    c.artifact = { model_id: "engine-managed-model" };
    const outcome = await pm.prepare(c);
    expect(outcome.cached).toBe(true);
    expect(outcome.files).toEqual({});
  });
});
