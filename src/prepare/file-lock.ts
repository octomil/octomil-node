/**
 * Cross-platform file locking for artifact downloads.
 *
 * Port of Python ``octomil/runtime/lifecycle/file_lock.py``. Prevents
 * concurrent downloads of the same artifact across processes.
 *
 * Design notes:
 *
 *   - Python uses OS-level advisory locks (``fcntl.flock`` on Unix,
 *     ``msvcrt.locking`` on Windows). Node has no equivalent in the
 *     standard library, so we build a comparable mechanism on top of
 *     ``fs.open`` with ``"wx"`` (O_CREAT | O_EXCL) plus a periodic
 *     refresh-stat to detect stale locks. The contract matches:
 *     ``acquire()`` blocks up to ``timeout`` ms; ``release()``
 *     removes the file; ``await using`` calls release on scope exit.
 *
 *   - The lock filename comes from
 *     :func:`safeFilesystemKey` so PrepareManager (artifact dir) and
 *     FileLock (lock file) use the same NAME_MAX-safe / Windows-safe
 *     key shape — same guarantee as the Python side.
 *
 *   - Stale-lock detection: if the lock file's mtime is older than
 *     ``staleTimeoutMs`` (default 5 minutes), assume the holder
 *     crashed and steal it. This matches the spirit of Python's
 *     ``flock`` behavior on process exit (the kernel releases the
 *     lock automatically) but applies to filesystem-only locks.
 *
 * @module prepare/file-lock
 */

import { homedir } from "node:os";
import * as path from "node:path";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { safeFilesystemKey } from "./fs-key.js";

/** Where lock files land by default. Mirror of Python's
 * ``_default_lock_dir``: ``OCTOMIL_CACHE_DIR/.locks`` if set,
 * else ``XDG_CACHE_HOME/octomil/artifacts/.locks``, else
 * ``~/.cache/octomil/artifacts/.locks``. */
function defaultLockDir(): string {
  const cacheRoot = process.env.OCTOMIL_CACHE_DIR;
  if (cacheRoot) {
    return path.join(cacheRoot, "artifacts", ".locks");
  }
  const xdgCacheHome = process.env.XDG_CACHE_HOME;
  if (xdgCacheHome) {
    return path.join(xdgCacheHome, "octomil", "artifacts", ".locks");
  }
  return path.join(homedir(), ".cache", "octomil", "artifacts", ".locks");
}

export interface FileLockOptions {
  /** Where to create the lock file. Defaults to the platform cache. */
  lockDir?: string;
  /** Maximum time to wait for the lock, in milliseconds. */
  timeoutMs?: number;
  /** How often to retry while another holder owns the lock. */
  pollIntervalMs?: number;
  /** Treat a lock file older than this as stale and steal it.
   * Defaults to 5 minutes — enough headroom for very large
   * downloads to refresh-stat without losing the lock, far short of
   * "the holder definitely crashed". */
  staleTimeoutMs?: number;
}

/**
 * Cross-process file lock backed by ``O_CREAT | O_EXCL``.
 *
 * Usage:
 *
 * ```ts
 * const lock = new FileLock("my-artifact-id");
 * await lock.acquire();
 * try {
 *   // ... materialize artifact ...
 * } finally {
 *   await lock.release();
 * }
 * ```
 *
 * Or, with explicit-resource-management (Node 22+):
 *
 * ```ts
 * await using lock = await FileLock.acquire("my-artifact-id");
 * // released on scope exit
 * ```
 */
export class FileLock {
  readonly lockPath: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly staleTimeoutMs: number;
  private fd: fs.FileHandle | null = null;
  private heldUntilStaleHandle: NodeJS.Timeout | null = null;

  constructor(name: string, options: FileLockOptions = {}) {
    const lockDir = options.lockDir ?? defaultLockDir();
    fsSync.mkdirSync(lockDir, { recursive: true });
    // NAME_MAX-safe, Windows-safe key — same helper PrepareManager
    // uses to derive the artifact directory, so the lock file and
    // the artifact dir agree on the shape of every planner id.
    const safeName = safeFilesystemKey(name);
    this.lockPath = path.join(lockDir, `${safeName}.lock`);
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.staleTimeoutMs = options.staleTimeoutMs ?? 5 * 60_000;
  }

  /** True iff this instance currently holds the lock. */
  get isLocked(): boolean {
    return this.fd !== null;
  }

  /** Acquire the lock, blocking up to ``timeoutMs``. Throws if the
   * deadline elapses before the lock can be taken. */
  async acquire(): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    await fs.mkdir(path.dirname(this.lockPath), { recursive: true });

    while (true) {
      try {
        // ``wx`` = ``O_WRONLY | O_CREAT | O_EXCL``. Atomic creation:
        // either we made the file (and now hold the lock), or
        // someone else has it.
        this.fd = await fs.open(this.lockPath, "wx");
        // Heartbeat: refresh mtime periodically so other waiters
        // can distinguish "long download in progress" from "the
        // holder process died". Without this, a 30-min download
        // would be incorrectly stolen at the 5-min stale cutoff.
        this.heldUntilStaleHandle = setInterval(() => {
          const now = new Date();
          fs.utimes(this.lockPath, now, now).catch(() => {
            // The file was removed (e.g. operator manual cleanup).
            // Drop the heartbeat; release() will no-op.
          });
        }, Math.max(this.staleTimeoutMs / 5, 1000));
        // ``setInterval`` keeps the event loop alive; ``unref()``
        // lets the process exit cleanly even if release was never
        // called (e.g. caller forgot to handle a thrown exception).
        this.heldUntilStaleHandle.unref();
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        // Someone else holds it (or did and crashed). Check stale.
        const stolen = await this.tryStealStaleLock();
        if (stolen) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Could not acquire lock ${this.lockPath} within ${this.timeoutMs}ms. ` +
              `Another process may be downloading this artifact.`,
          );
        }
        await sleep(this.pollIntervalMs);
      }
    }
  }

  /** Release the lock. Idempotent — calling twice is safe.
   * Removes the lock file so the next ``acquire()`` won't see
   * a stale-but-valid mtime. */
  async release(): Promise<void> {
    if (this.heldUntilStaleHandle) {
      clearInterval(this.heldUntilStaleHandle);
      this.heldUntilStaleHandle = null;
    }
    const fd = this.fd;
    this.fd = null;
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* fd already closed */
      }
    }
    try {
      await fs.unlink(this.lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Ignore — release should never propagate fs errors that
        // aren't user-actionable. The next ``acquire`` will detect
        // stale-lock or recreate.
      }
    }
  }

  /** Convenience constructor that acquires and returns the lock. */
  static async acquire(name: string, options?: FileLockOptions): Promise<FileLock> {
    const lock = new FileLock(name, options);
    await lock.acquire();
    return lock;
  }

  /** ``Symbol.asyncDispose`` integration so callers can use
   * ``await using lock = ...`` and have the lock release on
   * scope exit. Available on Node 22+. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  /**
   * If the lock file's mtime is older than ``staleTimeoutMs``,
   * assume the previous holder crashed: remove the lock and let
   * ``acquire()``'s next iteration claim it. Returns true iff a
   * stale lock was found and removed.
   */
  private async tryStealStaleLock(): Promise<boolean> {
    let stat;
    try {
      stat = await fs.stat(this.lockPath);
    } catch {
      // Disappeared between EEXIST and stat; the next iteration
      // will succeed at ``open(wx)``.
      return true;
    }
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs <= this.staleTimeoutMs) {
      return false;
    }
    try {
      await fs.unlink(this.lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Race: another waiter just stole it. Retry the open.
        return true;
      }
      // Permission / FS error — let the next iteration time out.
      return false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
