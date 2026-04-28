/**
 * Materializer — copies/links downloaded artifact bytes into the
 * runtime layout the engine expects.
 *
 * For Node's first prepare-for-real release we ship a *single-file*
 * Kokoro recipe: the artifact is one .onnx (or .gguf) blob, and the
 * runtime layout is simply `<artifact_root>/<filename>`. The
 * materialization step exists separately from the download step so:
 *
 *   1. Symlink-escape containment is enforced on the destination side.
 *      Even if the downloader writes the bytes correctly, materializing
 *      into a `runtime/` subdirectory through a hostile pre-existing
 *      symlink would let us land outside the artifact root.
 *   2. The lifecycle stays composable. When multi-file artifacts ship,
 *      the materializer learns to lay out a directory tree without the
 *      downloader needing to know runtime layout.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { safeJoinUnder } from "./safe-join.js";

export interface MaterializeOptions {
  /** Already-downloaded source file (validated digest). */
  sourcePath: string;
  /** Runtime root: where the engine looks for its model_dir. */
  runtimeDir: string;
  /** Relative path inside `runtimeDir` for this file. */
  relativePath: string;
  /** When true and the destination already exists with the same byte
   *  size, skip the copy. Mirrors Python materialization's idempotent
   *  behaviour — the downloader has already verified digest, so a
   *  size-equal cache hit is safe. */
  idempotent?: boolean;
}

export interface MaterializeResult {
  /** Absolute path to the materialized file inside `runtimeDir`. */
  destPath: string;
  /** True when the file was already in place and reused. */
  cacheHit: boolean;
}

/** Copy `sourcePath` into `runtimeDir/relativePath` with symlink-escape
 *  containment on the destination. Does NOT verify the digest again —
 *  the downloader is the authority on bytes-correctness. */
export async function materializeFile(
  options: MaterializeOptions,
): Promise<MaterializeResult> {
  await fsp.mkdir(options.runtimeDir, { recursive: true });
  const destPath = await safeJoinUnder(options.runtimeDir, options.relativePath);
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  if (options.idempotent !== false) {
    try {
      const [srcStat, dstStat] = await Promise.all([
        fsp.stat(options.sourcePath),
        fsp.stat(destPath),
      ]);
      if (srcStat.size === dstStat.size && srcStat.size > 0) {
        return { destPath, cacheHit: true };
      }
    } catch {
      // destination missing — fall through to copy
    }
  }

  // Atomic-ish: copy to `.tmp` then rename. The downloader already
  // produced a digest-verified source, so we don't re-hash here.
  const tmpPath = destPath + ".tmp";
  await fsp.copyFile(options.sourcePath, tmpPath);
  await fsp.rename(tmpPath, destPath);
  return { destPath, cacheHit: false };
}
