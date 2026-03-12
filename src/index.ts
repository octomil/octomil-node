export { OctomilClient } from "./client.js";
export { Model } from "./model.js";
export { InferenceEngine } from "./inference-engine.js";
export { ModelDownloader } from "./model-downloader.js";
export { FileCache } from "./file-cache.js";
export { TelemetryReporter } from "./telemetry.js";
export { computeFileHash } from "./integrity.js";
export { IntegrationsClient } from "./integrations.js";
export type {
  MetricsIntegration,
  LogIntegration,
  CreateMetricsIntegrationInput,
  CreateLogIntegrationInput,
  CreateOtlpCollectorInput,
} from "./integrations.js";
export { RoutingClient, detectDeviceCapabilities } from "./routing.js";
export type {
  DeviceCapabilities,
  RoutingPreference,
  RoutingDecision,
  RoutingFallbackTarget,
  RoutingConfig,
  CloudInferenceResponse,
} from "./routing.js";
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
export { OctomilError } from "./types.js";
export { embed } from "./embeddings.js";
export type {
  EmbeddingConfig,
  EmbeddingResult,
  EmbeddingUsage,
} from "./embeddings.js";
export { streamInference, parseSSELine } from "./streaming.js";
export type { StreamToken, StreamInput, StreamingConfig } from "./streaming.js";
export { QueryRouter, PolicyClient, assignTiers } from "./query-routing.js";
export type {
  RoutingPolicy,
  ModelInfo,
  QueryRoutingDecision,
} from "./query-routing.js";
export { ResponsesClient } from "./responses.js";
export { ChatClient } from "./chat.js";
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
export { CapabilitiesClient } from "./capabilities.js";
export type { CapabilityProfile } from "./capabilities.js";
export { ControlClient } from "./control.js";
export type {
  DeviceRegistration,
  HeartbeatResponse,
  DeviceAssignment,
  ControlSyncResult,
} from "./control.js";
export { ModelsClient } from "./models.js";
export type {
  ModelStatus,
  CachedModelInfo,
} from "./models.js";
