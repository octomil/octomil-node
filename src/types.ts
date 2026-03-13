import { ErrorCode, ERROR_CLASSIFICATION } from "./_generated/error_code.js";
export type { ErrorCategory, RetryClass, SuggestedAction, ErrorClassification } from "./_generated/error_code.js";
export { ErrorCode, ERROR_CLASSIFICATION } from "./_generated/error_code.js";

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
  | "NETWORK_ERROR"
  // --- Enriched taxonomy codes ---
  | "DEVICE_NOT_REGISTERED"
  | "UNSUPPORTED_MODALITY"
  | "CONTEXT_TOO_LARGE"
  | "VERSION_NOT_FOUND"
  | "ACCELERATOR_UNAVAILABLE"
  | "STREAM_INTERRUPTED"
  | "POLICY_DENIED"
  | "CLOUD_FALLBACK_DISALLOWED"
  | "MAX_TOOL_ROUNDS_EXCEEDED"
  | "CONTROL_SYNC_FAILED"
  | "ASSIGNMENT_NOT_FOUND"
  | "APP_BACKGROUNDED";

/** Map from contract ErrorCode to SDK OctomilErrorCode. */
export const ERROR_CODE_MAP: Readonly<Record<ErrorCode, OctomilErrorCode>> = {
  [ErrorCode.NetworkUnavailable]: "NETWORK_UNAVAILABLE",
  [ErrorCode.RequestTimeout]: "REQUEST_TIMEOUT",
  [ErrorCode.ServerError]: "SERVER_ERROR",
  [ErrorCode.InvalidApiKey]: "INVALID_API_KEY",
  [ErrorCode.AuthenticationFailed]: "AUTHENTICATION_FAILED",
  [ErrorCode.Forbidden]: "FORBIDDEN",
  [ErrorCode.ModelNotFound]: "MODEL_NOT_FOUND",
  [ErrorCode.ModelDisabled]: "MODEL_DISABLED",
  [ErrorCode.DownloadFailed]: "DOWNLOAD_FAILED",
  [ErrorCode.ChecksumMismatch]: "CHECKSUM_MISMATCH",
  [ErrorCode.InsufficientStorage]: "INSUFFICIENT_STORAGE",
  [ErrorCode.RuntimeUnavailable]: "RUNTIME_UNAVAILABLE",
  [ErrorCode.ModelLoadFailed]: "MODEL_LOAD_FAILED",
  [ErrorCode.InferenceFailed]: "INFERENCE_FAILED",
  [ErrorCode.InsufficientMemory]: "INSUFFICIENT_MEMORY",
  [ErrorCode.RateLimited]: "RATE_LIMITED",
  [ErrorCode.InvalidInput]: "INVALID_INPUT",
  [ErrorCode.Cancelled]: "CANCELLED",
  [ErrorCode.Unknown]: "UNKNOWN",
  [ErrorCode.DeviceNotRegistered]: "DEVICE_NOT_REGISTERED",
  [ErrorCode.UnsupportedModality]: "UNSUPPORTED_MODALITY",
  [ErrorCode.ContextTooLarge]: "CONTEXT_TOO_LARGE",
  [ErrorCode.VersionNotFound]: "VERSION_NOT_FOUND",
  [ErrorCode.AcceleratorUnavailable]: "ACCELERATOR_UNAVAILABLE",
  [ErrorCode.StreamInterrupted]: "STREAM_INTERRUPTED",
  [ErrorCode.PolicyDenied]: "POLICY_DENIED",
  [ErrorCode.CloudFallbackDisallowed]: "CLOUD_FALLBACK_DISALLOWED",
  [ErrorCode.MaxToolRoundsExceeded]: "MAX_TOOL_ROUNDS_EXCEEDED",
  [ErrorCode.ControlSyncFailed]: "CONTROL_SYNC_FAILED",
  [ErrorCode.AssignmentNotFound]: "ASSIGNMENT_NOT_FOUND",
  [ErrorCode.AppBackgrounded]: "APP_BACKGROUNDED",
} as const;

/** Reverse map: SDK error code -> contract ErrorCode. */
const SDK_TO_CONTRACT: Readonly<Partial<Record<OctomilErrorCode, ErrorCode>>> = Object.fromEntries(
  Object.entries(ERROR_CODE_MAP).map(([k, v]) => [v, k as unknown as ErrorCode]),
) as Partial<Record<OctomilErrorCode, ErrorCode>>;

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
    const cc = SDK_TO_CONTRACT[this.code];
    return cc != null && ERROR_CLASSIFICATION[cc].retryClass !== "never";
  }

  /** The error category from the contract taxonomy. */
  get category(): import("./_generated/error_code.js").ErrorCategory | undefined {
    const cc = SDK_TO_CONTRACT[this.code];
    return cc != null ? ERROR_CLASSIFICATION[cc].category : undefined;
  }

  /** The retry classification from the contract taxonomy. */
  get retryClass(): import("./_generated/error_code.js").RetryClass | undefined {
    const cc = SDK_TO_CONTRACT[this.code];
    return cc != null ? ERROR_CLASSIFICATION[cc].retryClass : undefined;
  }

  /** Whether this error is eligible for cloud fallback. */
  get fallbackEligible(): boolean {
    const cc = SDK_TO_CONTRACT[this.code];
    return cc != null ? ERROR_CLASSIFICATION[cc].fallbackEligible : false;
  }

  /** The suggested remediation action. */
  get suggestedAction(): import("./_generated/error_code.js").SuggestedAction | undefined {
    const cc = SDK_TO_CONTRACT[this.code];
    return cc != null ? ERROR_CLASSIFICATION[cc].suggestedAction : undefined;
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

  /** Create an OctomilError from a contract ErrorCode. */
  static fromErrorCode(errorCode: ErrorCode, message: string, cause?: unknown): OctomilError {
    const sdkCode = ERROR_CODE_MAP[errorCode];
    return new OctomilError(message, sdkCode, cause);
  }
}
