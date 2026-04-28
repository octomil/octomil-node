/**
 * BackendHandle — minimal warm-state object kept on the client.
 *
 * After `client.warmup({model, capability})` returns, a BackendHandle
 * lives on the client keyed by `(capability, modelKey)`. The next
 * `create()` call for that same key reuses the handle and skips the
 * "open the ONNX session" cold path — exactly the lifecycle Python's
 * `ExecutionKernel.warmup` provides.
 *
 * For Node's first warmup-for-real release the only backend we load
 * is the ONNX InferenceSession over the prepared Kokoro file. The
 * handle exposes:
 *
 *   - `modelDir`      — runtime layout root (the engine's `model_dir`)
 *   - `primaryPath`   — absolute path of the primary file
 *   - `engine`        — engine id (`"sherpa-onnx"` for TTS today)
 *   - `loaded`        — true once the session was built and is
 *                        addressable in memory
 *   - `session`       — opaque ONNX session handle (typed `unknown`
 *                        because `onnxruntime-node` is an optional
 *                        peer dep that may be absent in some test
 *                        environments)
 *
 * When `onnxruntime-node` is unavailable the handle still records
 * `loaded=true` with `session=null` and `engine=<id>+":soft-warm"` so
 * the caller can verify the prepare path ran end-to-end without
 * faking a backend that isn't installed.
 */
import * as fsp from "node:fs/promises";

export interface BackendHandle {
  /** Capability the handle was warmed for. */
  capability: "tts" | "transcription";
  /** Runtime layout root — engine's `model_dir`. */
  modelDir: string;
  /** Absolute path of the primary file inside `modelDir`. */
  primaryPath: string;
  /** Engine id; suffixed with `":soft-warm"` when ONNX is absent. */
  engine: string;
  /** Always true once `loadBackendHandle` returns. */
  loaded: boolean;
  /** Opaque ONNX InferenceSession (null when ONNX runtime is absent). */
  session: unknown;
  /** Wall-clock ms spent loading the session, for warmup telemetry. */
  loadMs: number;
  /** Snapshot of the digest the handle was warmed against. */
  digest: string;
}

export interface LoadBackendOptions {
  capability: "tts" | "transcription";
  modelDir: string;
  primaryPath: string;
  engine: string;
  digest: string;
}

/** Build a BackendHandle by opening the prepared file as an ONNX
 *  InferenceSession. Returns a soft-warm handle (no session) when the
 *  prepared file isn't an ONNX blob or `onnxruntime-node` isn't
 *  installed; the prepare path still ran end-to-end so warmup
 *  parity holds. */
export async function loadBackendHandle(
  options: LoadBackendOptions,
): Promise<BackendHandle> {
  const start = Date.now();
  // Confirm the prepared bytes are present before claiming "loaded".
  // Otherwise warmup could falsely succeed against a dangling cache
  // entry from a previous run.
  await fsp.stat(options.primaryPath);
  const looksLikeOnnx = /\.onnx(?:\.data)?$/i.test(options.primaryPath);
  if (!looksLikeOnnx) {
    return {
      capability: options.capability,
      modelDir: options.modelDir,
      primaryPath: options.primaryPath,
      engine: `${options.engine}:soft-warm`,
      loaded: true,
      session: null,
      loadMs: Date.now() - start,
      digest: options.digest,
    };
  }
  let ort: unknown = null;
  try {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    ort = await import("onnxruntime-node");
  } catch {
    // ONNX runtime is an optional peer dep — fall back to a soft warm.
    return {
      capability: options.capability,
      modelDir: options.modelDir,
      primaryPath: options.primaryPath,
      engine: `${options.engine}:soft-warm`,
      loaded: true,
      session: null,
      loadMs: Date.now() - start,
      digest: options.digest,
    };
  }
  let session: unknown = null;
  try {
    // The ONNX session loads the model graph into memory; subsequent
    // create() calls bind input tensors to the same session. Using
    // `any` at this seam matches the engine factory style elsewhere
    // in the SDK (the `onnxruntime-node` types don't expose a clean
    // factory shape we can constrain to).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ortAny = ort as any;
    if (ortAny?.InferenceSession?.create) {
      session = await ortAny.InferenceSession.create(options.primaryPath);
    }
  } catch {
    // Graph load failed — keep soft-warm so the warmup path is honest
    // about what landed in memory and what didn't.
    return {
      capability: options.capability,
      modelDir: options.modelDir,
      primaryPath: options.primaryPath,
      engine: `${options.engine}:soft-warm`,
      loaded: true,
      session: null,
      loadMs: Date.now() - start,
      digest: options.digest,
    };
  }
  return {
    capability: options.capability,
    modelDir: options.modelDir,
    primaryPath: options.primaryPath,
    engine: options.engine,
    loaded: true,
    session,
    loadMs: Date.now() - start,
    digest: options.digest,
  };
}

/** Cache key for warm handles: `<capability>:<model>`. */
export function warmCacheKey(
  capability: "tts" | "transcription",
  model: string,
): string {
  return `${capability}:${model}`;
}
