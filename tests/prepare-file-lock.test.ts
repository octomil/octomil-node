/**
 * Tests for ``src/prepare/file-lock.ts`` — cross-process file lock
 * for artifact materialization. Mirrors Python's
 * ``tests/test_file_lock.py`` invariants.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileLock } from "../src/prepare/file-lock.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "octomil-filelock-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("FileLock", () => {
  it("acquires and releases a fresh lock", async () => {
    const lock = new FileLock("artifact-1", { lockDir: tmpDir });
    await lock.acquire();
    expect(lock.isLocked).toBe(true);
    await fs.access(lock.lockPath); // file exists
    await lock.release();
    expect(lock.isLocked).toBe(false);
    await expect(fs.access(lock.lockPath)).rejects.toThrow();
  });

  it("blocks a second acquire on the same name within the same process", async () => {
    const a = new FileLock("artifact-1", { lockDir: tmpDir });
    const b = new FileLock("artifact-1", {
      lockDir: tmpDir,
      timeoutMs: 200,
      pollIntervalMs: 25,
    });
    await a.acquire();
    await expect(b.acquire()).rejects.toThrow(/Could not acquire lock/);
    await a.release();
    // Now b can take it.
    await b.acquire();
    expect(b.isLocked).toBe(true);
    await b.release();
  });

  it("releases idempotently — calling release twice is safe", async () => {
    const lock = new FileLock("artifact-2", { lockDir: tmpDir });
    await lock.acquire();
    await lock.release();
    await lock.release();
    expect(lock.isLocked).toBe(false);
  });

  it("uses the same key shape as PrepareManager via safeFilesystemKey", async () => {
    const lock = new FileLock("kokoro-82m", { lockDir: tmpDir });
    // Lock filename embeds the same hash suffix Python and Node
    // derive for the same artifact id (cross-SDK conformance).
    expect(path.basename(lock.lockPath)).toBe("kokoro-82m-64e5b12f9efb.lock");
  });

  it("steals stale locks", async () => {
    // Simulate a crashed holder by manually creating the lock file
    // and backdating its mtime well past the stale threshold.
    const a = new FileLock("artifact-3", { lockDir: tmpDir });
    await fs.mkdir(path.dirname(a.lockPath), { recursive: true });
    await fs.writeFile(a.lockPath, "");
    const oldTime = new Date(Date.now() - 60 * 60_000); // 1h ago
    await fs.utimes(a.lockPath, oldTime, oldTime);

    const b = new FileLock("artifact-3", {
      lockDir: tmpDir,
      staleTimeoutMs: 5 * 60_000, // 5 min
      timeoutMs: 1000,
      pollIntervalMs: 25,
    });
    await b.acquire();
    expect(b.isLocked).toBe(true);
    await b.release();
  });

  it("does not steal locks within the staleTimeoutMs window", async () => {
    const holder = new FileLock("artifact-4", { lockDir: tmpDir });
    await holder.acquire();
    const challenger = new FileLock("artifact-4", {
      lockDir: tmpDir,
      staleTimeoutMs: 60_000,
      timeoutMs: 200,
      pollIntervalMs: 25,
    });
    await expect(challenger.acquire()).rejects.toThrow(/Could not acquire lock/);
    await holder.release();
  });

  it("supports the explicit-resource-management asyncDispose protocol", async () => {
    const lockPath = await (async () => {
      // Manual await using emulation to avoid requiring the Node
      // 22+ syntax in the test file. Calls Symbol.asyncDispose
      // directly so the dispose contract is exercised even on 18+.
      const lock = await FileLock.acquire("artifact-5", { lockDir: tmpDir });
      try {
        return lock.lockPath;
      } finally {
        await (lock as unknown as AsyncDisposable)[Symbol.asyncDispose]();
      }
    })();
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
