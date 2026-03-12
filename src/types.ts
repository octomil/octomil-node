// Execution providers for onnxruntime-node
export type ExecutionProvider = "cpu" | "cuda" | "tensorrt" | "coreml";

export interface OctomilClientOptions {
  apiKey: string;
  orgId: string;
  serverUrl?: string;
  cacheDir?: string;
  telemetry?: boolean;
}

export interface PullOptions {
  version?: string;
  format?: string;
  force?: boolean;
  onProgress?: (downloaded: number, total: number) => void;
}

export interface LoadOptions {
  executionProvider?: ExecutionProvider;
  graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
  interOpNumThreads?: number;
  intraOpNumThreads?: number;
}

export type TensorData = Float32Array | Int32Array | BigInt64Array | Uint8Array;

export interface NamedTensors {
  [name: string]: { data: TensorData; dims: number[] };
}

export type PredictInput =
  | NamedTensors
  | { text: string }
  | { raw: TensorData; dims: number[] };

export interface PredictOutput {
  tensors: NamedTensors;
  label?: string;
  score?: number;
  scores?: number[];
  latencyMs: number;
}

export interface PullResult {
  name: string;
  tag: string;
  downloadUrl: string;
  format: string;
  sizeBytes: number;
  checksum?: string;
}

export interface CacheEntry {
  modelRef: string;
  filePath: string;
  checksum: string;
  cachedAt: string;
  sizeBytes: number;
}

export interface CacheInfo {
  modelRef: string;
  filePath: string;
  cachedAt: string;
  sizeBytes: number;
}

/**
 * Canonical error codes (19 codes + SDK-specific extras).
 *
 * The 19 canonical codes shared across all Octomil SDKs:
 *   MODEL_NOT_FOUND, MODEL_LOAD_FAILED, MODEL_DISABLED, INFERENCE_FAILED,
 *   NETWORK_UNAVAILABLE, INVALID_INPUT, INVALID_API_KEY,
 *   AUTHENTICATION_FAILED, FORBIDDEN, REQUEST_TIMEOUT, RATE_LIMITED,
 *   SERVER_ERROR, DOWNLOAD_FAILED, CHECKSUM_MISMATCH,
 *   INSUFFICIENT_STORAGE, INSUFFICIENT_MEMORY, RUNTIME_UNAVAILABLE,
 *   CANCELLED, UNKNOWN
 *
 * SDK-specific extras (kept for Node backwards-compat):
 *   NOT_LOADED, SESSION_DISPOSED, CACHE_ERROR, INTEGRITY_ERROR, NETWORK_ERROR
 */
export type OctomilErrorCode =
  // --- 19 canonical codes ---
  | "MODEL_NOT_FOUND"
  | "MODEL_LOAD_FAILED"
  | "MODEL_DISABLED"
  | "INFERENCE_FAILED"
  | "NETWORK_UNAVAILABLE"
  | "INVALID_INPUT"
  | "INVALID_API_KEY"
  | "AUTHENTICATION_FAILED"
  | "FORBIDDEN"
  | "REQUEST_TIMEOUT"
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "DOWNLOAD_FAILED"
  | "CHECKSUM_MISMATCH"
  | "INSUFFICIENT_STORAGE"
  | "INSUFFICIENT_MEMORY"
  | "RUNTIME_UNAVAILABLE"
  | "CANCELLED"
  | "UNKNOWN"
  // --- SDK-specific extras (backwards-compat) ---
  | "NOT_LOADED"
  | "SESSION_DISPOSED"
  | "CACHE_ERROR"
  | "INTEGRITY_ERROR"
  | "NETWORK_ERROR";

/** Codes that are safe to retry automatically. */
const RETRYABLE_CODES: ReadonlySet<OctomilErrorCode> = new Set([
  "NETWORK_UNAVAILABLE",
  "NETWORK_ERROR",
  "REQUEST_TIMEOUT",
  "SERVER_ERROR",
  "DOWNLOAD_FAILED",
  "CHECKSUM_MISMATCH",
  "INFERENCE_FAILED",
  "RATE_LIMITED",
]);

export class OctomilError extends Error {
  constructor(
    message: string,
    public readonly code: OctomilErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OctomilError";
  }

  /** Whether this error is safe to retry. */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  /**
   * Create an OctomilError from an HTTP status code.
   *
   * Maps common HTTP statuses to canonical error codes:
   *   401 -> INVALID_API_KEY
   *   403 -> FORBIDDEN
   *   404 -> MODEL_NOT_FOUND
   *   408 -> REQUEST_TIMEOUT
   *   429 -> RATE_LIMITED
   *   5xx -> SERVER_ERROR
   */
  static fromHttpStatus(status: number, message?: string): OctomilError {
    const msg = message ?? `HTTP ${status}`;
    if (status === 401) return new OctomilError(msg, "INVALID_API_KEY");
    if (status === 403) return new OctomilError(msg, "FORBIDDEN");
    if (status === 404) return new OctomilError(msg, "MODEL_NOT_FOUND");
    if (status === 408) return new OctomilError(msg, "REQUEST_TIMEOUT");
    if (status === 429) return new OctomilError(msg, "RATE_LIMITED");
    if (status >= 500) return new OctomilError(msg, "SERVER_ERROR");
    return new OctomilError(msg, "UNKNOWN");
  }
}
