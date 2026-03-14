// Auto-generated metric view constants.

export interface MetricView {
  name: string;
  instrument: string;
  unit: string;
  sourceSpan: string;
}

export const METRIC_NAMES = {
  octomilResponseDuration: "octomil.response.duration",
  octomilResponseTtft: "octomil.response.ttft",
  octomilResponseTokensPerSecond: "octomil.response.tokens_per_second",
  octomilModelLoadDuration: "octomil.model.load.duration",
  octomilModelLoadFailureRate: "octomil.model.load.failure_rate",
  octomilFallbackRate: "octomil.fallback.rate",
  octomilHeartbeatFreshness: "octomil.heartbeat.freshness",
  octomilToolExecuteDuration: "octomil.tool.execute.duration",
} as const;

export const ALL_METRIC_VIEWS: MetricView[] = [
  { name: "octomil.response.duration", instrument: "histogram", unit: "ms", sourceSpan: "octomil.response" },
  { name: "octomil.response.ttft", instrument: "histogram", unit: "ms", sourceSpan: "octomil.response" },
  { name: "octomil.response.tokens_per_second", instrument: "histogram", unit: "{tokens}/s", sourceSpan: "octomil.response" },
  { name: "octomil.model.load.duration", instrument: "histogram", unit: "ms", sourceSpan: "octomil.model.load" },
  { name: "octomil.model.load.failure_rate", instrument: "counter", unit: "{failures}", sourceSpan: "octomil.model.load" },
  { name: "octomil.fallback.rate", instrument: "counter", unit: "{fallbacks}", sourceSpan: "octomil.response" },
  { name: "octomil.heartbeat.freshness", instrument: "gauge", unit: "s", sourceSpan: "octomil.control.heartbeat" },
  { name: "octomil.tool.execute.duration", instrument: "histogram", unit: "ms", sourceSpan: "octomil.tool.execute" },
];
