/**
 * v2 OTLP-compatible telemetry reporter for the Octomil Node SDK.
 *
 * Emits events in the OTLP envelope format to POST /api/v2/telemetry/events:
 * {
 *   resource: { sdk, sdk_version, device_id, platform, org_id },
 *   events: [{ name, timestamp, attributes }]
 * }
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export interface TelemetryResource {
  sdk: "node";
  sdk_version: string;
  device_id: null;
  platform: string;
  org_id: string;
}

interface TelemetryEnvelope {
  resource: TelemetryResource;
  events: TelemetryEvent[];
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
  ) {
    this.flushInterval = flushInterval;
    this.maxBatchSize = maxBatchSize;
    this.resource = {
      sdk: "node",
      sdk_version: getSdkVersion(),
      device_id: null,
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
   *
   * The attributes dict should use dot-notation keys matching the v2 schema
   * (e.g. "model.id", "inference.duration_ms").
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
    const envelope: TelemetryEnvelope = {
      resource: this.resource,
      events: batch,
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

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    void this.flush();
  }
}
