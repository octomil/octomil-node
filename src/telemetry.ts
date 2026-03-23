/**
 * OTLP/JSON-compatible telemetry reporter for the Octomil Node SDK.
 *
 * Emits events in the OTLP ExportLogsServiceRequest format to
 * POST /api/v2/telemetry/events.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { OTLP_RESOURCE_ATTRIBUTES } from "./_generated/otlp_resource_attributes.js";

// ---------------------------------------------------------------------------
// OTLP Types
// ---------------------------------------------------------------------------

export interface OtlpKeyValue {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
  };
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber?: number;
  severityText?: string;
  body?: { stringValue: string };
  attributes?: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface ExportLogsServiceRequest {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{
      scope: { name: string; version?: string };
      logRecords: OtlpLogRecord[];
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Internal types (kept for queue + backward compat)
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export interface TelemetryResource {
  sdk: "node";
  sdk_version: string;
  device_id: string | null;
  install_id: string | null;
  platform: string;
  org_id: string;
}

// ---------------------------------------------------------------------------
// Event name mapping (v1 type -> v2 dot-notation name)
// ---------------------------------------------------------------------------

const EVENT_NAME_MAP: Record<string, string> = {
  inference: "inference.completed",
  cache_hit: "funnel.cache_hit",
  model_download: "funnel.model_download",
  model_load: "funnel.model_load",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSdkVersion(): string {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(thisDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "0.0.0";
  }
}

function toOtlpValue(v: unknown): OtlpKeyValue["value"] {
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  return { stringValue: String(v ?? "") };
}

function resourceToAttributes(resource: TelemetryResource): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [
    { key: "sdk", value: { stringValue: resource.sdk } },
    { key: "sdk_version", value: { stringValue: resource.sdk_version } },
    { key: "device_id", value: { stringValue: resource.device_id ?? "" } },
    { key: "platform", value: { stringValue: resource.platform } },
    { key: "org_id", value: { stringValue: resource.org_id } },
  ];
  if (resource.install_id) {
    attrs.push({
      key: OTLP_RESOURCE_ATTRIBUTES.octomilInstallId,
      value: { stringValue: resource.install_id },
    });
  }
  return attrs;
}

function eventToLogRecord(event: TelemetryEvent): OtlpLogRecord {
  const timeMs = new Date(event.timestamp).getTime();
  const timeUnixNano = String(timeMs * 1_000_000);
  const attributes: OtlpKeyValue[] = Object.entries(event.attributes).map(
    ([key, val]) => ({ key, value: toOtlpValue(val) }),
  );

  return {
    timeUnixNano,
    severityNumber: 9, // INFO
    severityText: "INFO",
    body: { stringValue: event.name },
    attributes,
  };
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export class TelemetryReporter {
  private queue: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly flushInterval: number;
  private readonly maxBatchSize: number;
  private readonly resource: TelemetryResource;

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    orgId: string,
    flushInterval = 30_000,
    maxBatchSize = 50,
    deviceId?: string,
    installId?: string,
  ) {
    this.flushInterval = flushInterval;
    this.maxBatchSize = maxBatchSize;
    this.resource = {
      sdk: "node",
      sdk_version: getSdkVersion(),
      device_id: deviceId ?? null,
      install_id: installId ?? null,
      platform: platform(),
      org_id: orgId,
    };
    this.timer = setInterval(() => void this.flush(), this.flushInterval);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Queue a telemetry event.
   *
   * Accepts a v2 dot-notation name (e.g. "inference.completed") or a legacy
   * v1 type string (e.g. "inference") which will be mapped automatically.
   */
  track(name: string, attributes: Record<string, unknown> = {}): void {
    const mappedName = EVENT_NAME_MAP[name] ?? name;
    this.queue.push({
      name: mappedName,
      timestamp: new Date().toISOString(),
      attributes,
    });
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.maxBatchSize);

    const envelope: ExportLogsServiceRequest = {
      resourceLogs: [
        {
          resource: { attributes: resourceToAttributes(this.resource) },
          scopeLogs: [
            {
              scope: { name: "@octomil/sdk", version: this.resource.sdk_version },
              logRecords: batch.map(eventToLogRecord),
            },
          ],
        },
      ],
    };

    try {
      await fetch(`${this.serverUrl}/api/v2/telemetry/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(envelope),
      });
    } catch {
      // best-effort — swallow errors
    }
  }

  async batch(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    this.queue.push(...events);
    await this.flush();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.flush();
  }
}
