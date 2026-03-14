// Auto-generated span event attribute key constants.

export const SPAN_EVENT_ATTRIBUTES = {
  octomilTtftMs: "octomil.ttft_ms",
  octomilChunkIndex: "octomil.chunk.index",
  octomilChunkLatencyMs: "octomil.chunk.latency_ms",
  octomilToolName: "octomil.tool.name",
  octomilToolRound: "octomil.tool.round",
  octomilFallbackReason: "octomil.fallback.reason",
  octomilFallbackProvider: "octomil.fallback.provider",
  octomilTokensTotal: "octomil.tokens.total",
  octomilTokensPerSecond: "octomil.tokens.per_second",
  octomilDurationMs: "octomil.duration_ms",
  octomilDownloadUrl: "octomil.download.url",
  octomilDownloadExpectedBytes: "octomil.download.expected_bytes",
  octomilDownloadDurationMs: "octomil.download.duration_ms",
  octomilDownloadBytes: "octomil.download.bytes",
  octomilChecksumAlgorithm: "octomil.checksum.algorithm",
  octomilRuntimeExecutor: "octomil.runtime.executor",
  octomilRuntimeInitMs: "octomil.runtime.init_ms",
} as const;

export const EVENT_REQUIRED_ATTRIBUTES: Record<string, string[]> = {
  "first_token": ["octomil.ttft_ms"],
  "chunk_produced": ["octomil.chunk.index"],
  "tool_call_emitted": ["octomil.tool.name", "octomil.tool.round"],
  "fallback_triggered": ["octomil.fallback.reason"],
  "completed": ["octomil.tokens.total", "octomil.tokens.per_second", "octomil.duration_ms"],
  "download_started": [],
  "download_completed": ["octomil.download.duration_ms", "octomil.download.bytes"],
  "checksum_verified": [],
  "runtime_initialized": ["octomil.runtime.executor", "octomil.runtime.init_ms"],
};
