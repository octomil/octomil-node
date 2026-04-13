// Auto-generated span attribute key constants.

export const SPAN_ATTRIBUTES = {
  modelId: "model.id",
  modelVersion: "model.version",
  runtimeExecutor: "runtime.executor",
  requestMode: "request.mode",
  locality: "locality",
  streaming: "streaming",
  routePolicy: "route.policy",
  routeDecision: "route.decision",
  deviceClass: "device.class",
  fallbackReason: "fallback.reason",
  errorType: "error.type",
  toolCallTier: "tool.call_tier",
  kvCacheStrategy: "kv_cache.strategy",
  kvCacheQuantizationBits: "kv_cache.quantization_bits",
  kvCacheCompressionRatio: "kv_cache.compression_ratio",
  modelSourceFormat: "model.source_format",
  modelSizeBytes: "model.size_bytes",
  toolName: "tool.name",
  toolRound: "tool.round",
  fallbackProvider: "fallback.provider",
  assignmentCount: "assignment_count",
  heartbeatSequence: "heartbeat.sequence",
  rolloutId: "rollout.id",
  modelsSynced: "models_synced",
} as const;

export const SPAN_REQUIRED_ATTRIBUTES: Record<string, string[]> = {
  "octomil.response": ["model.id", "model.version", "runtime.executor", "request.mode", "locality", "streaming"],
  "octomil.model.load": ["model.id", "model.version", "runtime.executor"],
  "octomil.tool.execute": ["tool.name", "tool.round"],
  "octomil.fallback.cloud": ["model.id", "fallback.reason"],
  "octomil.control.refresh": [],
  "octomil.control.heartbeat": ["heartbeat.sequence"],
  "octomil.rollout.sync": ["rollout.id"],
};
