// Auto-generated from octomil-contracts. Do not edit.

export enum ErrorCode {
  InvalidApiKey = "invalid_api_key",
  AuthenticationFailed = "authentication_failed",
  Forbidden = "forbidden",
  DeviceNotRegistered = "device_not_registered",
  TokenExpired = "token_expired",
  DeviceRevoked = "device_revoked",
  NetworkUnavailable = "network_unavailable",
  RequestTimeout = "request_timeout",
  ServerError = "server_error",
  RateLimited = "rate_limited",
  InvalidInput = "invalid_input",
  UnsupportedModality = "unsupported_modality",
  ContextTooLarge = "context_too_large",
  ModelNotFound = "model_not_found",
  ModelDisabled = "model_disabled",
  VersionNotFound = "version_not_found",
  DownloadFailed = "download_failed",
  ChecksumMismatch = "checksum_mismatch",
  InsufficientStorage = "insufficient_storage",
  InsufficientMemory = "insufficient_memory",
  RuntimeUnavailable = "runtime_unavailable",
  AcceleratorUnavailable = "accelerator_unavailable",
  ModelLoadFailed = "model_load_failed",
  InferenceFailed = "inference_failed",
  StreamInterrupted = "stream_interrupted",
  PolicyDenied = "policy_denied",
  CloudFallbackDisallowed = "cloud_fallback_disallowed",
  MaxToolRoundsExceeded = "max_tool_rounds_exceeded",
  TrainingFailed = "training_failed",
  TrainingNotSupported = "training_not_supported",
  WeightUploadFailed = "weight_upload_failed",
  ControlSyncFailed = "control_sync_failed",
  AssignmentNotFound = "assignment_not_found",
  Cancelled = "cancelled",
  AppBackgrounded = "app_backgrounded",
  Unknown = "unknown",
}

export type ErrorCategory =
  | "auth"
  | "network"
  | "input"
  | "catalog"
  | "download"
  | "device"
  | "runtime"
  | "policy"
  | "training"
  | "control"
  | "lifecycle"
  | "unknown";

export type RetryClass =
  | "never"
  | "immediate_safe"
  | "backoff_safe"
  | "conditional";

export type SuggestedAction =
  | "fix_credentials"
  | "reauthenticate"
  | "check_permissions"
  | "register_device"
  | "retry_or_fallback"
  | "retry"
  | "retry_after"
  | "fix_request"
  | "reduce_input_or_fallback"
  | "check_model_id"
  | "use_alternate_model"
  | "check_version"
  | "redownload"
  | "free_storage_or_fallback"
  | "try_smaller_model"
  | "try_alternate_runtime"
  | "try_cpu_or_fallback"
  | "check_policy"
  | "change_policy_or_fix_local"
  | "increase_limit_or_simplify"
  | "check_assignment"
  | "none"
  | "resume_on_foreground"
  | "report_bug";

export interface ErrorClassification {
  category: ErrorCategory;
  retryClass: RetryClass;
  fallbackEligible: boolean;
  suggestedAction: SuggestedAction;
}

export const ERROR_CLASSIFICATION: Record<ErrorCode, ErrorClassification> = {
  [ErrorCode.InvalidApiKey]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_credentials" },
  [ErrorCode.AuthenticationFailed]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "reauthenticate" },
  [ErrorCode.Forbidden]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "check_permissions" },
  [ErrorCode.DeviceNotRegistered]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "register_device" },
  [ErrorCode.TokenExpired]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "reauthenticate" },
  [ErrorCode.DeviceRevoked]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "register_device" },
  [ErrorCode.NetworkUnavailable]: { category: "network", retryClass: "backoff_safe", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.RequestTimeout]: { category: "network", retryClass: "conditional", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.ServerError]: { category: "network", retryClass: "backoff_safe", fallbackEligible: true, suggestedAction: "retry" },
  [ErrorCode.RateLimited]: { category: "network", retryClass: "conditional", fallbackEligible: false, suggestedAction: "retry_after" },
  [ErrorCode.InvalidInput]: { category: "input", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.UnsupportedModality]: { category: "input", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ContextTooLarge]: { category: "input", retryClass: "never", fallbackEligible: true, suggestedAction: "reduce_input_or_fallback" },
  [ErrorCode.ModelNotFound]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "check_model_id" },
  [ErrorCode.ModelDisabled]: { category: "catalog", retryClass: "never", fallbackEligible: true, suggestedAction: "use_alternate_model" },
  [ErrorCode.VersionNotFound]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "check_version" },
  [ErrorCode.DownloadFailed]: { category: "download", retryClass: "backoff_safe", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.ChecksumMismatch]: { category: "download", retryClass: "conditional", fallbackEligible: false, suggestedAction: "redownload" },
  [ErrorCode.InsufficientStorage]: { category: "device", retryClass: "never", fallbackEligible: true, suggestedAction: "free_storage_or_fallback" },
  [ErrorCode.InsufficientMemory]: { category: "device", retryClass: "never", fallbackEligible: true, suggestedAction: "try_smaller_model" },
  [ErrorCode.RuntimeUnavailable]: { category: "device", retryClass: "never", fallbackEligible: true, suggestedAction: "try_alternate_runtime" },
  [ErrorCode.AcceleratorUnavailable]: { category: "device", retryClass: "never", fallbackEligible: true, suggestedAction: "try_cpu_or_fallback" },
  [ErrorCode.ModelLoadFailed]: { category: "runtime", retryClass: "conditional", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.InferenceFailed]: { category: "runtime", retryClass: "conditional", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.StreamInterrupted]: { category: "runtime", retryClass: "immediate_safe", fallbackEligible: true, suggestedAction: "retry" },
  [ErrorCode.PolicyDenied]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "check_policy" },
  [ErrorCode.CloudFallbackDisallowed]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "change_policy_or_fix_local" },
  [ErrorCode.MaxToolRoundsExceeded]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "increase_limit_or_simplify" },
  [ErrorCode.TrainingFailed]: { category: "training", retryClass: "conditional", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.TrainingNotSupported]: { category: "training", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.WeightUploadFailed]: { category: "training", retryClass: "backoff_safe", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.ControlSyncFailed]: { category: "control", retryClass: "backoff_safe", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.AssignmentNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "check_assignment" },
  [ErrorCode.Cancelled]: { category: "lifecycle", retryClass: "never", fallbackEligible: false, suggestedAction: "none" },
  [ErrorCode.AppBackgrounded]: { category: "lifecycle", retryClass: "conditional", fallbackEligible: false, suggestedAction: "resume_on_foreground" },
  [ErrorCode.Unknown]: { category: "unknown", retryClass: "never", fallbackEligible: false, suggestedAction: "report_bug" },
};
