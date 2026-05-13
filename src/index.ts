// ---------------------------------------------------------------------------
// Unified facade
// ---------------------------------------------------------------------------

export { Octomil, OctomilNotInitializedError, FacadeEmbeddings } from "./facade.js";
export {
  PREPAREABLE_CAPABILITIES,
  canPrepareCandidate,
} from "./prepare/prepare.js";
export type { PrepareOptions, PrepareOutcome } from "./prepare/prepare.js";
export type {
  OctomilFacadeEnvOptions,
  OctomilFacadeOptions,
  OctomilLocalOptions,
  LocalTranscriptionResult,
} from "./facade.js";
export {
  discoverLocalRunner,
  discoverFromEnv,
  discoverFromCli,
  localRunnerPost,
  localRunnerMultipartPost,
  localRunnerHealthCheck,
} from "./local.js";
export type {
  LocalRunnerEndpoint,
  LocalRunnerDiscoveryOptions,
} from "./local.js";
export { buildLocalLifecycleStatus, buildUnavailableStatus } from "./local-lifecycle.js";
export type { LocalLifecycleStatus, LocalCacheStatus } from "./local-lifecycle.js";

// ---------------------------------------------------------------------------
// Core tier (MUST) — required for all SDK consumers
// ---------------------------------------------------------------------------

/** @tier Core */
export { ResponsesClient } from "./responses.js";
export { ToolRunner } from "./responses-tools.js";
/** @tier Core */
export { ChatClient } from "./chat.js";
/** @tier Core */
export { ControlClient } from "./control.js";
/** @tier Core */
export { DevicesClient } from "./devices.js";
/** @tier Core */
export { CapabilitiesClient } from "./capabilities.js";
/** @tier Core */
export { ModelsClient } from "./models.js";
/** @tier Core */
export { OctomilClient } from "./client.js";
/** @tier Core */
export type { TelemetryFacade } from "./client.js";
/** @tier Core */
export { OctomilError } from "./types.js";
export { ArtifactsClient } from "./artifacts.js";
export { FederationClient } from "./federation.js";
export { MonitoringClient } from "./monitoring.js";
export { SettingsClient } from "./settings.js";
export { TrainingClient } from "./training.js";

// Core type exports

export type {
  ResponseRequest,
  ContentBlock,
  ResponseInputItem,
  ToolDef,
  ResponseToolCall,
  ResponseOutput,
  ResponseObj,
  ResponseUsage,
  TextDeltaEvent,
  ReasoningDeltaEvent,
  ToolCallDeltaEvent,
  DoneEvent,
  ResponseStreamEvent,
  ResponsesClientOptions,
} from "./responses.js";
export type {
  LocalResponsesRuntime,
  LocalResponsesRuntimeResolver,
} from "./responses-runtime.js";
export type { ToolExecutor, ToolResult } from "./responses-tools.js";
export type {
  ChatMessage,
  ChatRequest,
  ChatCompletion,
  ChatChoice,
  ToolCall,
  ChatChunk,
  ChatChunkChoice,
  ToolCallDelta,
} from "./chat.js";
export type {
  DeviceRegistration,
  HeartbeatResponse,
  DeviceAssignment,
  ControlSyncResult,
  DeviceSyncRequest,
  DeviceSyncResponse,
} from "./control.js";
export type { CapabilityProfile } from "./capabilities.js";
export type { ModelStatus, CachedModelInfo } from "./models.js";
export type {
  ExecutionProvider,
  OctomilClientOptions,
  AuthConfig,
  OrgApiKeyAuth,
  DeviceTokenAuth,
  PullOptions,
  LoadOptions,
  PredictInput,
  PredictOutput,
  NamedTensors,
  TensorData,
  PullResult,
  CacheEntry,
  CacheInfo,
  OctomilErrorCode,
} from "./types.js";
export { AuthType } from "./_generated/auth_type.js";
export { PrincipalType } from "./_generated/principal_type.js";
export { Scope } from "./_generated/scope.js";

// ---------------------------------------------------------------------------
// Manifest-driven runtime (Phase 1)
// ---------------------------------------------------------------------------

export { ModelRef } from "./model-ref.js";
export type { ModelRefById, ModelRefByCapability } from "./model-ref.js";

export { ModelCatalogService } from "./manifest/catalog-service.js";
export type {
  CloudRuntimeFactory,
  CatalogServiceOptions,
} from "./manifest/catalog-service.js";
export { ModelReadinessManager } from "./manifest/readiness-manager.js";
export type {
  ReadinessEvent,
  ReadinessListener,
} from "./manifest/readiness-manager.js";
export type {
  AppManifest,
  AppModelEntry,
  AppRoutingPolicy,
  TaskTaxonomy,
  ManifestResource,
  ResourceCompression,
  ManifestPackage,
  ManifestModel,
  ClientManifest,
  ResourceBindings,
} from "./manifest/types.js";
export {
  ArtifactResourceKind,
  Modality,
  effectiveRoutingPolicy,
  manifestEntryForCapability,
  manifestEntryForModelId,
  resolveResourceBindings,
  requireResourceBinding,
  parseManifestResource,
  parseManifestPackage,
  parseManifestModel,
  parseClientManifest,
  packageSupportsInputModality,
  isVisionLanguagePackage,
  defaultPackage,
  packagesForPlatform,
  resourcesOfKind,
} from "./manifest/types.js";
export { LocalFileModelRuntime } from "./runtime/engines/local-file-runtime.js";
export {
  NativeRuntime,
  NativeRuntimeError,
  OCT_CACHE_SCOPE_APP,
  OCT_CACHE_SCOPE_REQUEST,
  OCT_CACHE_SCOPE_RUNTIME,
  OCT_CACHE_SCOPE_SESSION,
  discoverNativeRuntime,
  readNativeCapabilities,
  requireNativeCapability,
} from "./runtime/native/index.js";
export type {
  NativeCacheEntrySnapshot,
  NativeCacheScope,
  NativeCacheSnapshot,
  NativeRuntimeCapabilities,
  NativeRuntimeDiscovery,
  NativeRuntimeOpenOptions,
} from "./runtime/native/index.js";

// Audio namespace
export { OctomilAudio } from "./audio/octomil-audio.js";
export { AudioTranscriptions } from "./audio/audio-transcriptions.js";
export type { TranscriptionRequest } from "./audio/audio-transcriptions.js";
export type {
  TranscriptionResult,
  TranscriptionSegment,
} from "./audio/transcription-types.js";

// Text namespace
export { OctomilText } from "./text/octomil-text.js";
export { OctomilPredictor } from "./text/octomil-predictor.js";

// ---------------------------------------------------------------------------
// Device registration (Phase 2)
// ---------------------------------------------------------------------------

export { DeviceContext } from "./device-context.js";
export type { RegistrationState, TokenState } from "./device-context.js";
export { configure, getDeviceContext } from "./configure.js";
export type { ConfigureOptions } from "./configure.js";
export type {
  SilentAuthConfig,
  PublishableKeyEnvironment,
} from "./auth-config.js";
export {
  validatePublishableKey,
  getPublishableKeyEnvironment,
  PublishableKeyAuth,
} from "./auth-config.js";
export type { MonitoringConfig } from "./monitoring-config.js";

// Contract-generated enums (new)
export { ModelCapability } from "./_generated/model_capability.js";
export { DeliveryMode } from "./_generated/delivery_mode.js";
export { RoutingPolicy as RoutingPolicyEnum } from "./_generated/routing_policy.js";

// ---------------------------------------------------------------------------
// Advanced tier (MAY) — optional, for power users
// ---------------------------------------------------------------------------

/** @tier Advanced */
export { RoutingClient, detectDeviceCapabilities } from "./routing.js";
/** @tier Advanced */
export { QueryRouter, PolicyClient, assignTiers } from "./query-routing.js";

// Advanced type exports

export type {
  DeviceCapabilities,
  RoutingPreference,
  RoutingDecision,
  RoutingFallbackTarget,
  RoutingConfig,
  CloudInferenceResponse,
} from "./routing.js";
export type {
  RoutingPolicy,
  ModelInfo,
  QueryRoutingDecision,
} from "./query-routing.js";

// ---------------------------------------------------------------------------
// Runtime planner (server-assisted engine selection)
// ---------------------------------------------------------------------------

export { RuntimePlannerClient, parsePlanResponse } from "./planner/index.js";
export type { RuntimePlannerClientOptions } from "./planner/index.js";
export { collectDeviceRuntimeProfile } from "./planner/index.js";
export { SUPPORTED_POLICIES, isSupportedPolicy } from "./planner/index.js";
export type {
  SupportedPolicy,
  PlannerCapability,
  InstalledRuntime,
  DeviceRuntimeProfile,
  RuntimePlanRequest,
  RuntimeArtifactPlan,
  RuntimeCandidatePlan,
  RuntimePlanResponse,
  RuntimeBenchmarkSubmission,
  RuntimeDefaultsResponse,
  RouteExecution,
  RouteModelRequested,
  RouteModelResolved,
  RouteModel,
  ArtifactCache,
  RouteArtifact,
  PlannerInfo,
  FallbackInfo,
  RouteReason,
  RouteMetadata as PlannerRouteMetadata,
} from "./planner/index.js";

// ---------------------------------------------------------------------------
// Candidate attempt runner (per-request candidate evaluation loop)
// ---------------------------------------------------------------------------

export {
  CandidateAttemptRunner,
  NoOpRuntimeChecker,
  NoOpGateEvaluator,
  AttemptStage,
  AttemptStatus,
  GateStatus,
  GATE_CODES,
} from "./runtime/routing/attempt-runner.js";
export type {
  GateCode,
  GateResult,
  AttemptArtifact,
  RouteAttempt,
  FallbackTrigger,
  AttemptLoopResult,
  RuntimeChecker,
  GateEvaluator,
  CandidateGate,
  CandidatePlan,
} from "./runtime/routing/attempt-runner.js";
export { PlannerClient } from "./runtime/routing/planner-client.js";
export type { PlannerClientConfig, PlanRequest } from "./runtime/routing/planner-client.js";
export {
  RequestRouter,
  buildRouteMetadata,
} from "./runtime/routing/request-router.js";
export type {
  PlannerResult,
  RequestRoutingContext,
  RouteMetadata,
  RoutingDecision as RuntimeRoutingDecision,
  RouterConfig,
  RoutableCapability,
} from "./runtime/routing/request-router.js";
export { parseModelRef } from "./runtime/routing/model-ref-parser.js";
export type { ParsedModelRef, ModelRefKind } from "./runtime/routing/model-ref-parser.js";
export {
  buildRouteEvent,
  validateRouteEvent,
  FORBIDDEN_TELEMETRY_FIELDS,
} from "./runtime/routing/route-event.js";
export type { RouteEvent, AttemptDetail } from "./runtime/routing/route-event.js";

// ---------------------------------------------------------------------------
// Output quality evaluators (post-inference gate evaluation)
// ---------------------------------------------------------------------------

export {
  JsonParseableEvaluator,
  JsonSchemaEvaluator,
  ToolCallValidEvaluator,
  RegexPredicateEvaluator,
  SafetyPassedEvaluator,
  EvaluatorRegistry,
  RegistryBackedEvaluator,
  extractText,
  extractToolCalls,
} from "./runtime/routing/evaluators.js";
export type {
  EvaluatorResult,
  OutputQualityEvaluator,
} from "./runtime/routing/evaluators.js";

// ---------------------------------------------------------------------------
// Infrastructure — internal utilities exposed for advanced use
// ---------------------------------------------------------------------------

export type { ModelRuntime } from "./runtime/core/model-runtime.js";
export { Model } from "./model.js";
export { InferenceEngine } from "./runtime/engines/onnx/engine.js";
export { ModelDownloader } from "./model-downloader.js";
export { FileCache } from "./file-cache.js";
export { TelemetryReporter } from "./telemetry.js";
export type {
  ExportLogsServiceRequest,
  OtlpKeyValue,
  OtlpLogRecord,
  TelemetryEvent,
  TelemetryResource,
} from "./telemetry.js";
export { computeFileHash } from "./integrity.js";
export { IntegrationsClient } from "./integrations.js";
export type {
  MetricsIntegration,
  LogIntegration,
  CreateMetricsIntegrationInput,
  CreateLogIntegrationInput,
  CreateOtlpCollectorInput,
} from "./integrations.js";
export type {
  ArtifactManifest,
  ArtifactDownloadUrls,
  ArtifactDownloadUrlsRequest,
} from "./artifacts.js";
export type { AlertRule, UpdateAlertRuleRequest } from "./monitoring.js";
export type {
  BillingSession,
  BillingState,
  UsageLimits,
  Integration,
  IntegrationValidation,
  IntegrationPatch,
} from "./settings.js";
export type { TrainingJob, TrainingJobStatus } from "./training.js";
export { embed } from "./embeddings.js";
export type {
  EmbeddingConfig,
  EmbeddingResult,
  EmbeddingUsage,
} from "./embeddings.js";
export { streamInference, parseSSELine } from "./streaming.js";
export type { StreamToken, StreamInput, StreamingConfig } from "./streaming.js";

// ---------------------------------------------------------------------------
// Contract-generated types (from octomil-contracts)
// ---------------------------------------------------------------------------

export {
  ErrorCode,
  ModelStatus as ContractModelStatus,
  DeviceClass,
  FinishReason,
  CompatibilityLevel,
  OTLP_RESOURCE_ATTRIBUTES,
  SPAN_EVENT_NAMES,
  EVENT_REQUIRED_ATTRIBUTES,
  ArtifactResourceKind as ContractArtifactResourceKind,
  Modality as ContractModality,
  InputModality,
} from "./_generated/index.js";
