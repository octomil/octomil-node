// Auto-generated telemetry event names.

export const TELEMETRY_EVENTS = {
  inferenceStarted: "inference.started",
  inferenceCompleted: "inference.completed",
  inferenceFailed: "inference.failed",
  inferenceChunkProduced: "inference.chunk_produced",
  deployStarted: "deploy.started",
  deployCompleted: "deploy.completed",
} as const;

export const EVENT_REQUIRED_ATTRIBUTES: Record<string, string[]> = {
  "inference.started": ["model.id"],
  "inference.completed": ["model.id", "inference.duration_ms"],
  "inference.failed": ["model.id", "error.type", "error.message"],
  "inference.chunk_produced": ["model.id", "inference.chunk_index"],
  "deploy.started": ["model.id", "model.version"],
  "deploy.completed": ["model.id", "deploy.duration_ms"],
};
