// ---------------------------------------------------------------------------
// Core tier (MUST) — required for all SDK consumers
// ---------------------------------------------------------------------------

/** @tier Core */
export { ResponsesClient } from "./responses.js";
/** @tier Core */
export { ChatClient } from "./chat.js";
/** @tier Core */
export { ControlClient } from "./control.js";
/** @tier Core */
export { CapabilitiesClient } from "./capabilities.js";
/** @tier Core */
export { ModelsClient } from "./models.js";
/** @tier Core */
export { OctomilClient } from "./client.js";
/** @tier Core */
export { OctomilError } from "./types.js";

// Core type exports

export type {
  ResponseRequest,
  ContentBlock,
  ToolDef,
  ResponseOutput,
  ResponseObj,
  ResponseUsage,
  TextDeltaEvent,
  ToolCallDeltaEvent,
  DoneEvent,
  ResponseStreamEvent,
  ResponsesClientOptions,
} from "./responses.js";
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
} from "./control.js";
export type { CapabilityProfile } from "./capabilities.js";
export type {
  ModelStatus,
  CachedModelInfo,
} from "./models.js";
export type {
  ExecutionProvider,
  OctomilClientOptions,
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
// Infrastructure — internal utilities exposed for advanced use
// ---------------------------------------------------------------------------

export { Model } from "./model.js";
export { InferenceEngine } from "./inference-engine.js";
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
export { embed } from "./embeddings.js";
export type {
  EmbeddingConfig,
  EmbeddingResult,
  EmbeddingUsage,
} from "./embeddings.js";
export { streamInference, parseSSELine } from "./streaming.js";
export type { StreamToken, StreamInput, StreamingConfig } from "./streaming.js";
