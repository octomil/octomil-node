/**
 * Tests for ``src/prepare/durable-download.ts`` — the resumable
 * multi-URL artifact downloader. Mirrors a subset of Python's
 * ``tests/test_durable_downloader.py`` invariants.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DurableDownloader,
  type ArtifactDescriptor,
  digestMatches,
  safeJoin,
  validateRelativePath,
} from "../src/prepare/durable-download.js";
import { OctomilError } from "../src/types.js";

let tmpDir: string;
let cacheDir: string;
let destDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "octomil-dd-"));
  cacheDir = path.join(tmpDir, "cache");
  destDir = path.join(tmpDir, "dest");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(destDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function sha256Hex(buf: Buffer): string {
  return `sha256:${createHash("sha256").update(buf).digest("hex")}`;
}

function makeFetch(responses: Map<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const factory = responses.get(url);
    if (!factory) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
    return factory();
  }) as typeof fetch;
}

describe("validateRelativePath", () => {
  it("accepts empty string for single-file artifacts", () => {
    expect(validateRelativePath("")).toBe("");
  });

  it("accepts simple POSIX paths", () => {
    expect(validateRelativePath("model.onnx")).toBe("model.onnx");
    expect(validateRelativePath("subdir/model.onnx")).toBe("subdir/model.onnx");
  });

  it("rejects backslashes", () => {
    expect(() => validateRelativePath("model\\v1")).toThrow(OctomilError);
    expect(() => validateRelativePath("model\\v1")).toThrow(/backslashes/);
  });

  it("rejects NUL bytes", () => {
    expect(() => validateRelativePath("model\u0000.onnx")).toThrow(/NUL byte/);
  });

  it("rejects '..' traversal segments", () => {
    expect(() => validateRelativePath("../etc/passwd")).toThrow(/'\.\.'/);
    expect(() => validateRelativePath("a/../b")).toThrow(/'\.\.'/);
  });

  it("rejects '.' current-dir segments", () => {
    expect(() => validateRelativePath("./model.onnx")).toThrow(/'\.'/);
  });

  it("rejects empty segments", () => {
    expect(() => validateRelativePath("a//b")).toThrow(/empty/);
  });

  it("rejects absolute paths", () => {
    // Tripped by either the empty-leading-segment rule or the
    // explicit absolute-path rule — both fire before the input
    // could escape, which is the actual contract.
    expect(() => validateRelativePath("/etc/passwd")).toThrow(OctomilError);
  });

  it("rejects Windows drive letters", () => {
    expect(() => validateRelativePath("C:foo")).toThrow(/Windows drive/);
  });
});

describe("safeJoin", () => {
  // Use ``tmpDir`` (already realpath-resolved on macOS where ``/tmp``
  // is a symlink to ``/private/tmp``) so the resolved candidate the
  // post-PR-symlink-fix returns matches the lexical join exactly.
  it("joins under destDir", async () => {
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "safejoin-"));
    try {
      const expected = path.join(await fs.realpath(dest), "model.onnx");
      expect(safeJoin(dest, "model.onnx")).toBe(expected);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("returns destDir for empty relative", async () => {
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "safejoin-"));
    try {
      expect(safeJoin(dest, "")).toBe(await fs.realpath(dest));
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it("rejects traversal that escapes destDir", async () => {
    const dest = await fs.mkdtemp(path.join(os.tmpdir(), "safejoin-"));
    try {
      expect(() => safeJoin(dest, "../escape.txt")).toThrow(OctomilError);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

describe("digestMatches", () => {
  it("returns true for matching SHA-256", async () => {
    const file = path.join(tmpDir, "f.bin");
    await fs.writeFile(file, Buffer.from("hello world"));
    const expected = sha256Hex(Buffer.from("hello world"));
    expect(await digestMatches(file, expected)).toBe(true);
  });

  it("accepts bare hex (no sha256: prefix)", async () => {
    const file = path.join(tmpDir, "f.bin");
    await fs.writeFile(file, Buffer.from("hello world"));
    const bare = sha256Hex(Buffer.from("hello world")).slice(7);
    expect(await digestMatches(file, bare)).toBe(true);
  });

  it("returns false for mismatched digest", async () => {
    const file = path.join(tmpDir, "f.bin");
    await fs.writeFile(file, Buffer.from("hello world"));
    expect(await digestMatches(file, "sha256:" + "0".repeat(64))).toBe(false);
  });

  it("returns false for missing file", async () => {
    expect(await digestMatches(path.join(tmpDir, "nope"), "sha256:" + "0".repeat(64))).toBe(false);
  });
});

describe("DurableDownloader.download", () => {
  it("downloads a single-file artifact end-to-end and verifies digest", async () => {
    const payload = Buffer.from("the quick brown fox jumps over the lazy dog");
    const url = "https://cdn.example.com/artifact.bin";
    const fetchImpl = makeFetch(
      new Map([[url, () => new Response(payload, { status: 200, headers: { "content-length": String(payload.byteLength) } })]]),
    );

    const downloader = new DurableDownloader(cacheDir, { fetchImpl });
    const result = await downloader.download(
      {
        artifactId: "test-artifact",
        requiredFiles: [{ relativePath: "", digest: sha256Hex(payload) }],
        endpoints: [{ url }],
      },
      destDir,
    );

    const finalPath = result.files[""];
    expect(finalPath).toBeDefined();
    const actual = await fs.readFile(finalPath!);
    expect(actual.equals(payload)).toBe(true);
  });

  it("throws CHECKSUM_MISMATCH when digest does not match", async () => {
    const payload = Buffer.from("real bytes");
    const fetchImpl = makeFetch(
      new Map([["https://cdn.example.com/x", () => new Response(payload, { status: 200 })]]),
    );
    const downloader = new DurableDownloader(cacheDir, { fetchImpl });
    await expect(
      downloader.download(
        {
          artifactId: "bad-digest",
          requiredFiles: [{ relativePath: "", digest: "sha256:" + "0".repeat(64) }],
          endpoints: [{ url: "https://cdn.example.com/x" }],
        },
        destDir,
      ),
    ).rejects.toThrow(/Exhausted all endpoints/);
  });

  it("falls through to second endpoint when first 404s", async () => {
    const payload = Buffer.from("fallback bytes");
    const fetchImpl = makeFetch(
      new Map<string, () => Response>([
        ["https://primary.example.com/x", () => new Response(null, { status: 404 })],
        [
          "https://backup.example.com/x",
          () => new Response(payload, { status: 200 }),
        ],
      ]),
    );
    const downloader = new DurableDownloader(cacheDir, { fetchImpl });
    const result = await downloader.download(
      {
        artifactId: "fallback",
        requiredFiles: [{ relativePath: "", digest: sha256Hex(payload) }],
        endpoints: [
          { url: "https://primary.example.com/x" },
          { url: "https://backup.example.com/x" },
        ],
      },
      destDir,
    );
    const final = await fs.readFile(result.files[""]!);
    expect(final.equals(payload)).toBe(true);
  });

  it("skips an expired endpoint without making an HTTP request", async () => {
    const payload = Buffer.from("backup payload");
    let primaryHits = 0;
    const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://primary.example.com/x") {
        primaryHits++;
        return new Response(payload, { status: 200 });
      }
      if (url === "https://backup.example.com/x") {
        return new Response(payload, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const downloader = new DurableDownloader(cacheDir, {
      fetchImpl,
      now: () => Date.parse("2026-01-01T00:00:00Z"),
    });
    await downloader.download(
      {
        artifactId: "expired-skip",
        requiredFiles: [{ relativePath: "", digest: sha256Hex(payload) }],
        endpoints: [
          { url: "https://primary.example.com/x", expiresAt: "2025-01-01T00:00:00Z" },
          { url: "https://backup.example.com/x" },
        ],
      },
      destDir,
    );
    expect(primaryHits).toBe(0);
  });

  it("returns the final path immediately when the file exists and verifies", async () => {
    const payload = Buffer.from("already there");
    const finalPath = path.join(destDir, "artifact");
    await fs.writeFile(finalPath, payload);

    let fetchHits = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchHits++;
      return new Response(payload, { status: 200 });
    }) as typeof fetch;

    const downloader = new DurableDownloader(cacheDir, { fetchImpl });
    await downloader.download(
      {
        artifactId: "cached",
        requiredFiles: [{ relativePath: "", digest: sha256Hex(payload) }],
        endpoints: [{ url: "https://cdn.example.com/x" }],
      },
      destDir,
    );
    expect(fetchHits).toBe(0);
  });

  it("rejects empty endpoint list at the boundary", async () => {
    const downloader = new DurableDownloader(cacheDir);
    await expect(
      downloader.download(
        {
          artifactId: "no-endpoints",
          requiredFiles: [{ relativePath: "", digest: "sha256:" + "0".repeat(64) }],
          endpoints: [],
        },
        destDir,
      ),
    ).rejects.toThrow(/no download endpoints/);
  });

  it("rejects empty required_files list at the boundary", async () => {
    const downloader = new DurableDownloader(cacheDir);
    await expect(
      downloader.download(
        {
          artifactId: "no-files",
          requiredFiles: [],
          endpoints: [{ url: "https://cdn.example.com/x" }],
        } as ArtifactDescriptor,
        destDir,
      ),
    ).rejects.toThrow(/no required_files/);
  });
});
