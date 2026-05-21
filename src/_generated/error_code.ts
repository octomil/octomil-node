// Auto-generated from octomil-contracts. Do not edit.

export enum ErrorCode {
  InvalidApiKey = "invalid_api_key",
  AuthenticationFailed = "authentication_failed",
  Forbidden = "forbidden",
  InsufficientScope = "insufficient_scope",
  MissingOrgContext = "missing_org_context",
  DeviceNotRegistered = "device_not_registered",
  TokenExpired = "token_expired",
  DeviceRevoked = "device_revoked",
  PasskeyChallengeExpired = "passkey_challenge_expired",
  PasskeyCredentialNotFound = "passkey_credential_not_found",
  InvalidToken = "invalid_token",
  EmailAlreadyVerified = "email_already_verified",
  EmailAlreadyInUse = "email_already_in_use",
  LastAuthMethod = "last_auth_method",
  OauthProviderNotLinked = "oauth_provider_not_linked",
  NetworkUnavailable = "network_unavailable",
  RequestTimeout = "request_timeout",
  ServerError = "server_error",
  RateLimited = "rate_limited",
  InvalidInput = "invalid_input",
  UnsupportedModality = "unsupported_modality",
  ContextTooLarge = "context_too_large",
  ModelNotFound = "model_not_found",
  NoDefaultModel = "no_default_model",
  CapabilityNotSupported = "capability_not_supported",
  PreviousResponseNotFound = "previous_response_not_found",
  AppNotFound = "app_not_found",
  CapabilityNotConfigured = "capability_not_configured",
  AppContextConflict = "app_context_conflict",
  InvalidModelRef = "invalid_model_ref",
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
  ProviderError = "provider_error",
  UpstreamProviderError = "upstream_provider_error",
  TooManyTools = "too_many_tools",
  UnsupportedToolCalling = "unsupported_tool_calling",
  StreamInterrupted = "stream_interrupted",
  PolicyDenied = "policy_denied",
  CloudFallbackDisallowed = "cloud_fallback_disallowed",
  CloudInferenceNotAllowed = "cloud_inference_not_allowed",
  HostedTtsDisabled = "hosted_tts_disabled",
  PlanLimitExceeded = "plan_limit_exceeded",
  CloudCredentialsMissing = "cloud_credentials_missing",
  CloudCredentialsRevoked = "cloud_credentials_revoked",
  CloudProviderAuthFailed = "cloud_provider_auth_failed",
  MaxToolRoundsExceeded = "max_tool_rounds_exceeded",
  TrainingFailed = "training_failed",
  TrainingNotSupported = "training_not_supported",
  WeightUploadFailed = "weight_upload_failed",
  ControlSyncFailed = "control_sync_failed",
  AssignmentNotFound = "assignment_not_found",
  IncidentNotFound = "incident_not_found",
  DeploymentNotFound = "deployment_not_found",
  ExperimentNotFound = "experiment_not_found",
  ExperimentStateInvalid = "experiment_state_invalid",
  ApiKeyNotFound = "api_key_not_found",
  ApiKeyAlreadyRevoked = "api_key_already_revoked",
  IntegrationNotFound = "integration_not_found",
  BillingCustomerNotFound = "billing_customer_not_found",
  ActionNotFound = "action_not_found",
  ActionStateInvalid = "action_state_invalid",
  CredentialNotFound = "credential_not_found",
  ConnectionNotFound = "connection_not_found",
  LocalRuntimeNotFound = "local_runtime_not_found",
  CheckoutNotComplete = "checkout_not_complete",
  UpstreamProviderUnavailable = "upstream_provider_unavailable",
  AgentSystemUnavailable = "agent_system_unavailable",
  ThreadNotFound = "thread_not_found",
  RunNotFound = "run_not_found",
  RunStateInvalid = "run_state_invalid",
  ApprovalNotFound = "approval_not_found",
  ApprovalAlreadyResolved = "approval_already_resolved",
  JobNotFound = "job_not_found",
  JobStateInvalid = "job_state_invalid",
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
  | "fix_request"
  | "retry_or_fallback"
  | "retry"
  | "retry_after"
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
  [ErrorCode.InsufficientScope]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "check_permissions" },
  [ErrorCode.MissingOrgContext]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "check_permissions" },
  [ErrorCode.DeviceNotRegistered]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "register_device" },
  [ErrorCode.TokenExpired]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "reauthenticate" },
  [ErrorCode.DeviceRevoked]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "register_device" },
  [ErrorCode.PasskeyChallengeExpired]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "reauthenticate" },
  [ErrorCode.PasskeyCredentialNotFound]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.InvalidToken]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.EmailAlreadyVerified]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.EmailAlreadyInUse]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.LastAuthMethod]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.OauthProviderNotLinked]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.NetworkUnavailable]: { category: "network", retryClass: "backoff_safe", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.RequestTimeout]: { category: "network", retryClass: "conditional", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.ServerError]: { category: "network", retryClass: "backoff_safe", fallbackEligible: true, suggestedAction: "retry" },
  [ErrorCode.RateLimited]: { category: "network", retryClass: "conditional", fallbackEligible: false, suggestedAction: "retry_after" },
  [ErrorCode.InvalidInput]: { category: "input", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.UnsupportedModality]: { category: "input", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ContextTooLarge]: { category: "input", retryClass: "never", fallbackEligible: true, suggestedAction: "reduce_input_or_fallback" },
  [ErrorCode.ModelNotFound]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "check_model_id" },
  [ErrorCode.NoDefaultModel]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "check_model_id" },
  [ErrorCode.CapabilityNotSupported]: { category: "catalog", retryClass: "never", fallbackEligible: true, suggestedAction: "use_alternate_model" },
  [ErrorCode.PreviousResponseNotFound]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.AppNotFound]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.CapabilityNotConfigured]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.AppContextConflict]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.InvalidModelRef]: { category: "catalog", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
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
  [ErrorCode.ProviderError]: { category: "runtime", retryClass: "never", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.UpstreamProviderError]: { category: "runtime", retryClass: "backoff_safe", fallbackEligible: true, suggestedAction: "retry_or_fallback" },
  [ErrorCode.TooManyTools]: { category: "runtime", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.UnsupportedToolCalling]: { category: "runtime", retryClass: "never", fallbackEligible: true, suggestedAction: "use_alternate_model" },
  [ErrorCode.StreamInterrupted]: { category: "runtime", retryClass: "immediate_safe", fallbackEligible: true, suggestedAction: "retry" },
  [ErrorCode.PolicyDenied]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "check_policy" },
  [ErrorCode.CloudFallbackDisallowed]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "change_policy_or_fix_local" },
  [ErrorCode.CloudInferenceNotAllowed]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "check_policy" },
  [ErrorCode.HostedTtsDisabled]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "check_policy" },
  [ErrorCode.PlanLimitExceeded]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "increase_limit_or_simplify" },
  [ErrorCode.CloudCredentialsMissing]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_credentials" },
  [ErrorCode.CloudCredentialsRevoked]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_credentials" },
  [ErrorCode.CloudProviderAuthFailed]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_credentials" },
  [ErrorCode.MaxToolRoundsExceeded]: { category: "policy", retryClass: "never", fallbackEligible: false, suggestedAction: "increase_limit_or_simplify" },
  [ErrorCode.TrainingFailed]: { category: "training", retryClass: "conditional", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.TrainingNotSupported]: { category: "training", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.WeightUploadFailed]: { category: "training", retryClass: "backoff_safe", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.ControlSyncFailed]: { category: "control", retryClass: "backoff_safe", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.AssignmentNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "check_assignment" },
  [ErrorCode.IncidentNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "none" },
  [ErrorCode.DeploymentNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ExperimentNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ExperimentStateInvalid]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ApiKeyNotFound]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ApiKeyAlreadyRevoked]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.IntegrationNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.BillingCustomerNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ActionNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ActionStateInvalid]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.CredentialNotFound]: { category: "auth", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ConnectionNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.LocalRuntimeNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.CheckoutNotComplete]: { category: "control", retryClass: "conditional", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.UpstreamProviderUnavailable]: { category: "network", retryClass: "backoff_safe", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.AgentSystemUnavailable]: { category: "network", retryClass: "backoff_safe", fallbackEligible: false, suggestedAction: "retry" },
  [ErrorCode.ThreadNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.RunNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.RunStateInvalid]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ApprovalNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.ApprovalAlreadyResolved]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.JobNotFound]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.JobStateInvalid]: { category: "control", retryClass: "never", fallbackEligible: false, suggestedAction: "fix_request" },
  [ErrorCode.Cancelled]: { category: "lifecycle", retryClass: "never", fallbackEligible: false, suggestedAction: "none" },
  [ErrorCode.AppBackgrounded]: { category: "lifecycle", retryClass: "conditional", fallbackEligible: false, suggestedAction: "resume_on_foreground" },
  [ErrorCode.Unknown]: { category: "unknown", retryClass: "never", fallbackEligible: false, suggestedAction: "report_bug" },
};
