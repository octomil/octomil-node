import { ErrorCode, ERROR_CLASSIFICATION } from "./_generated/error_code.js";
export type { ErrorCategory, RetryClass, SuggestedAction, ErrorClassification } from "./_generated/error_code.js";
export { ErrorCode, ERROR_CLASSIFICATION } from "./_generated/error_code.js";
export { AuthType } from "./_generated/auth_type.js";
export { PrincipalType } from "./_generated/principal_type.js";
export { Scope } from "./_generated/scope.js";
import type {
  LocalResponsesRuntime,
  LocalResponsesRuntimeResolver,
} from "./responses-runtime.js";

// ---------------------------------------------------------------------------
// Auth Config (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Organization-scoped API key authentication.
 * Used by server-side SDKs, CLI tools, and CI/CD pipelines.
 */
export interface OrgApiKeyAuth {
  type: "org_api_key";
  apiKey: string;
  orgId: string;
  serverUrl?: string;
}

/**
 * Short-lived device token authentication.
 * Used by edge devices that go through a bootstrap/registration flow.
 */
export interface DeviceTokenAuth {
  type: "device_token";
  deviceId: string;
  bootstrapToken: string;
  serverUrl?: string;
}

/**
 * Discriminated union of supported authentication configurations.
 *
 * @example
 * ```ts
 * const auth: AuthConfig = {
 *   type: "org_api_key",
 *   apiKey: "YOUR_SERVER_KEY",
 *   orgId: "org_123",
 * };
 * ```
 */
export type AuthConfig = OrgApiKeyAuth | DeviceTokenAuth;

// Execution providers for onnxruntime-node
export type ExecutionProvider = "cpu" | "cuda" | "tensorrt" | "coreml";

export interface OctomilClientOptions {
  auth: AuthConfig;
  cacheDir?: string;
  telemetry?: boolean;
  /** Custom model runtime implementation. */
  runtime?: import("./runtime/core/model-runtime.js").ModelRuntime;
  /**
   * Optional local runtime used by `responses.create()` / `responses.stream()`.
   *
   * When provided, the Node SDK can execute the structured responses API
   * locally instead of requiring a server-backed chat completions endpoint.
   */
  responsesRuntime?: LocalResponsesRuntime | LocalResponsesRuntimeResolver;
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

// ---------------------------------------------------------------------------
// Back-compat: OctomilErrorCode is kept as a type alias for ErrorCode so
// existing code that imported `OctomilErrorCode` continues to compile.
// Callers should migrate to `ErrorCode` directly.
// @deprecated Use ErrorCode from "./_generated/error_code.js" instead.
// ---------------------------------------------------------------------------
/** @deprecated Use {@link ErrorCode} instead. */
export type OctomilErrorCode = ErrorCode;

// ---------------------------------------------------------------------------
// Reverse-lookup table: old SCREAMING_SNAKE_CASE strings → ErrorCode
// Used by the back-compat constructor shim only.
// ---------------------------------------------------------------------------
const SCREAMING_TO_ENUM: Readonly<Record<string, ErrorCode>> = {
  INVALID_API_KEY: ErrorCode.InvalidApiKey,
  AUTHENTICATION_FAILED: ErrorCode.AuthenticationFailed,
  FORBIDDEN: ErrorCode.Forbidden,
  INSUFFICIENT_SCOPE: ErrorCode.InsufficientScope,
  MISSING_ORG_CONTEXT: ErrorCode.MissingOrgContext,
  DEVICE_NOT_REGISTERED: ErrorCode.DeviceNotRegistered,
  TOKEN_EXPIRED: ErrorCode.TokenExpired,
  DEVICE_REVOKED: ErrorCode.DeviceRevoked,
  NETWORK_UNAVAILABLE: ErrorCode.NetworkUnavailable,
  REQUEST_TIMEOUT: ErrorCode.RequestTimeout,
  SERVER_ERROR: ErrorCode.ServerError,
  RATE_LIMITED: ErrorCode.RateLimited,
  INVALID_INPUT: ErrorCode.InvalidInput,
  UNSUPPORTED_MODALITY: ErrorCode.UnsupportedModality,
  CONTEXT_TOO_LARGE: ErrorCode.ContextTooLarge,
  MODEL_NOT_FOUND: ErrorCode.ModelNotFound,
  NO_DEFAULT_MODEL: ErrorCode.NoDefaultModel,
  CAPABILITY_NOT_SUPPORTED: ErrorCode.CapabilityNotSupported,
  PREVIOUS_RESPONSE_NOT_FOUND: ErrorCode.PreviousResponseNotFound,
  APP_NOT_FOUND: ErrorCode.AppNotFound,
  CAPABILITY_NOT_CONFIGURED: ErrorCode.CapabilityNotConfigured,
  APP_CONTEXT_CONFLICT: ErrorCode.AppContextConflict,
  INVALID_MODEL_REF: ErrorCode.InvalidModelRef,
  MODEL_DISABLED: ErrorCode.ModelDisabled,
  VERSION_NOT_FOUND: ErrorCode.VersionNotFound,
  DOWNLOAD_FAILED: ErrorCode.DownloadFailed,
  CHECKSUM_MISMATCH: ErrorCode.ChecksumMismatch,
  INSUFFICIENT_STORAGE: ErrorCode.InsufficientStorage,
  INSUFFICIENT_MEMORY: ErrorCode.InsufficientMemory,
  RUNTIME_UNAVAILABLE: ErrorCode.RuntimeUnavailable,
  ACCELERATOR_UNAVAILABLE: ErrorCode.AcceleratorUnavailable,
  MODEL_LOAD_FAILED: ErrorCode.ModelLoadFailed,
  INFERENCE_FAILED: ErrorCode.InferenceFailed,
  PROVIDER_ERROR: ErrorCode.ProviderError,
  UPSTREAM_PROVIDER_ERROR: ErrorCode.UpstreamProviderError,
  TOO_MANY_TOOLS: ErrorCode.TooManyTools,
  UNSUPPORTED_TOOL_CALLING: ErrorCode.UnsupportedToolCalling,
  STREAM_INTERRUPTED: ErrorCode.StreamInterrupted,
  POLICY_DENIED: ErrorCode.PolicyDenied,
  CLOUD_FALLBACK_DISALLOWED: ErrorCode.CloudFallbackDisallowed,
  CLOUD_INFERENCE_NOT_ALLOWED: ErrorCode.CloudInferenceNotAllowed,
  HOSTED_TTS_DISABLED: ErrorCode.HostedTtsDisabled,
  PLAN_LIMIT_EXCEEDED: ErrorCode.PlanLimitExceeded,
  CLOUD_CREDENTIALS_MISSING: ErrorCode.CloudCredentialsMissing,
  CLOUD_CREDENTIALS_REVOKED: ErrorCode.CloudCredentialsRevoked,
  CLOUD_PROVIDER_AUTH_FAILED: ErrorCode.CloudProviderAuthFailed,
  MAX_TOOL_ROUNDS_EXCEEDED: ErrorCode.MaxToolRoundsExceeded,
  TRAINING_FAILED: ErrorCode.TrainingFailed,
  TRAINING_NOT_SUPPORTED: ErrorCode.TrainingNotSupported,
  WEIGHT_UPLOAD_FAILED: ErrorCode.WeightUploadFailed,
  CONTROL_SYNC_FAILED: ErrorCode.ControlSyncFailed,
  ASSIGNMENT_NOT_FOUND: ErrorCode.AssignmentNotFound,
  INCIDENT_NOT_FOUND: ErrorCode.IncidentNotFound,
  DEPLOYMENT_NOT_FOUND: ErrorCode.DeploymentNotFound,
  EXPERIMENT_NOT_FOUND: ErrorCode.ExperimentNotFound,
  EXPERIMENT_STATE_INVALID: ErrorCode.ExperimentStateInvalid,
  CANCELLED: ErrorCode.Cancelled,
  APP_BACKGROUNDED: ErrorCode.AppBackgrounded,
  UNKNOWN: ErrorCode.Unknown,
};

/** Set of all valid ErrorCode enum values for fast membership testing. */
const VALID_ERROR_CODE_VALUES = new Set<string>(Object.values(ErrorCode));

/**
 * Normalize a string or ErrorCode to a canonical ErrorCode enum value.
 *
 * Accepts:
 *   - An ErrorCode enum value (snake_case string like "inference_failed") — returned as-is.
 *   - A legacy SCREAMING_SNAKE_CASE string like "INFERENCE_FAILED" — mapped via lookup table.
 *   - Unknown strings — warns and falls back to ErrorCode.Unknown.
 */
function normalizeCode(code: ErrorCode | string): ErrorCode {
  // Already a valid enum value (snake_case)
  if (VALID_ERROR_CODE_VALUES.has(code)) {
    return code as ErrorCode;
  }
  // Legacy SCREAMING_SNAKE_CASE
  const mapped = SCREAMING_TO_ENUM[code];
  if (mapped !== undefined) {
    return mapped;
  }
  // Unknown string — warn and fall back
  console.warn(
    `[OctomilError] Unrecognized error code "${code}"; falling back to ErrorCode.Unknown. ` +
    `Pass an ErrorCode enum value instead of a raw string.`,
  );
  return ErrorCode.Unknown;
}

export class OctomilError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode | string,
    message: string,
    optionsOrCause?: { cause?: unknown; retryAfterMs?: number } | unknown,
  ) {
    super(message);
    this.name = "OctomilError";
    this.code = normalizeCode(code);

    // Accept both the new options-object form and the legacy positional `cause` form.
    if (
      optionsOrCause !== null &&
      typeof optionsOrCause === "object" &&
      !Array.isArray(optionsOrCause) &&
      !(optionsOrCause instanceof Error) &&
      ("cause" in (optionsOrCause as object) || "retryAfterMs" in (optionsOrCause as object))
    ) {
      const opts = optionsOrCause as { cause?: unknown; retryAfterMs?: number };
      this.cause = opts.cause;
      this.retryAfterMs = opts.retryAfterMs;
    } else if (optionsOrCause !== undefined) {
      // Legacy: third arg is a raw cause value (old call sites: new OctomilError(code, msg, err))
      this.cause = optionsOrCause;
    }
  }

  /** Whether this error is safe to retry. */
  get retryable(): boolean {
    return ERROR_CLASSIFICATION[this.code].retryClass !== "never";
  }

  /** The error category from the contract taxonomy. */
  get category(): import("./_generated/error_code.js").ErrorCategory {
    return ERROR_CLASSIFICATION[this.code].category;
  }

  /** The retry classification from the contract taxonomy. */
  get retryClass(): import("./_generated/error_code.js").RetryClass {
    return ERROR_CLASSIFICATION[this.code].retryClass;
  }

  /** Whether this error is eligible for cloud fallback. */
  get fallbackEligible(): boolean {
    return ERROR_CLASSIFICATION[this.code].fallbackEligible;
  }

  /** The suggested remediation action. */
  get suggestedAction(): import("./_generated/error_code.js").SuggestedAction {
    return ERROR_CLASSIFICATION[this.code].suggestedAction;
  }

  /**
   * Create an OctomilError from an HTTP status code.
   *
   * Maps common HTTP statuses to canonical error codes:
   *   400 -> InvalidInput
   *   401 -> AuthenticationFailed
   *   403 -> Forbidden
   *   404 -> ModelNotFound (on model endpoints; Unknown elsewhere)
   *   429 -> RateLimited
   *   5xx -> ServerError
   */
  static fromHttpStatus(status: number, message?: string): OctomilError {
    const msg = message ?? `HTTP ${status}`;
    if (status === 400) return new OctomilError(ErrorCode.InvalidInput, msg);
    if (status === 401) return new OctomilError(ErrorCode.AuthenticationFailed, msg);
    if (status === 403) return new OctomilError(ErrorCode.Forbidden, msg);
    if (status === 404) return new OctomilError(ErrorCode.ModelNotFound, msg);
    if (status === 429) return new OctomilError(ErrorCode.RateLimited, msg);
    if (status >= 500) return new OctomilError(ErrorCode.ServerError, msg);
    return new OctomilError(ErrorCode.Unknown, msg);
  }

  /** Create an OctomilError from a contract ErrorCode. */
  static fromErrorCode(errorCode: ErrorCode, message: string, cause?: unknown): OctomilError {
    return new OctomilError(errorCode, message, cause);
  }

  /**
   * Create an OctomilError from a server error response body.
   *
   * Extracts the `code` field from the JSON body and maps it to the SDK's
   * error code enum. Falls back to HTTP status mapping when the `code` field
   * is absent or unrecognized.
   */
  static fromServerResponse(
    status: number,
    body: Record<string, unknown> | null,
  ): OctomilError {
    const message =
      (typeof body?.message === "string" ? body.message : null) ??
      (typeof body?.error === "string" ? body.error : null) ??
      `HTTP ${status}`;

    // Try to map the server's `code` field to a contract ErrorCode.
    if (typeof body?.code === "string") {
      const contractValues = Object.values(ErrorCode) as string[];
      if (contractValues.includes(body.code)) {
        return new OctomilError(body.code as ErrorCode, message);
      }
    }

    // Fall back to HTTP status mapping.
    return OctomilError.fromHttpStatus(status, message);
  }
}
