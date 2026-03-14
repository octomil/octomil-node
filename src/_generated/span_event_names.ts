// Auto-generated span event name constants.

export const SPAN_EVENT_NAMES = {
  firstToken: "first_token",
  chunkProduced: "chunk_produced",
  toolCallEmitted: "tool_call_emitted",
  fallbackTriggered: "fallback_triggered",
  completed: "completed",
  downloadStarted: "download_started",
  downloadCompleted: "download_completed",
  checksumVerified: "checksum_verified",
  runtimeInitialized: "runtime_initialized",
} as const;

export const EVENT_PARENT_SPAN: Record<string, string> = {
  "first_token": "octomil.response",
  "chunk_produced": "octomil.response",
  "tool_call_emitted": "octomil.response",
  "fallback_triggered": "octomil.response",
  "completed": "octomil.response",
  "download_started": "octomil.model.load",
  "download_completed": "octomil.model.load",
  "checksum_verified": "octomil.model.load",
  "runtime_initialized": "octomil.model.load",
};
