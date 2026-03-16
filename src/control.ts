/**
 * Control namespace — device registration, heartbeat, and assignment refresh.
 * Matches SDK_FACADE_CONTRACT.md control.register(), control.heartbeat(),
 * control.refresh(), control.startHeartbeat(), control.stopHeartbeat().
 */

import { OctomilError } from "./types.js";
import { hostname, platform, arch, release } from "node:os";
import { SPAN_NAMES } from "./_generated/span_names.js";
import { SPAN_ATTRIBUTES } from "./_generated/span_attributes.js";
import type { TelemetryReporter } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeviceRegistration {
  id: string;
  deviceIdentifier: string;
  orgId: string;
  status: string;
}

export interface HeartbeatResponse {
  status: string;
  serverTime?: string;
}

export interface DeviceAssignment {
  modelId: string;
  version?: string;
  config?: Record<string, unknown>;
}

export interface ControlSyncResult {
  updated: boolean;
  configVersion: string;
  assignmentsChanged: boolean;
  rolloutsChanged: boolean;
  fetchedAt: string;
  assignments?: DeviceAssignment[];
}

// ---------------------------------------------------------------------------
// Wire-format types (snake_case from server)
// ---------------------------------------------------------------------------

interface WireDeviceRegistration {
  id: string;
  device_identifier: string;
  org_id: string;
  status: string;
}

interface WireHeartbeatResponse {
  status: string;
  server_time?: string;
}

interface WireAssignmentsResponse {
  assignments?: Array<{
    model_id: string;
    version?: string;
    config?: Record<string, unknown>;
  }>;
  config_version?: string;
  rollouts_changed?: boolean;
}

// ---------------------------------------------------------------------------
// ControlClient
// ---------------------------------------------------------------------------

export class ControlClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly orgId: string;
  private deviceId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private previousAssignments: DeviceAssignment[] | null = null;
  private heartbeatSequence = 0;
  private readonly telemetry: TelemetryReporter | null;

  constructor(serverUrl: string, apiKey: string, orgId: string, telemetry?: TelemetryReporter | null) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.orgId = orgId;
    this.telemetry = telemetry ?? null;
  }

  /**
   * Register this device with the control plane.
   * If a deviceId is provided it is used as the device identifier;
   * otherwise a default based on the hostname is generated.
   */
  async register(deviceId?: string): Promise<DeviceRegistration> {
    const identifier = deviceId ?? `${hostname()}-${platform()}-${arch()}`;

    const body = {
      device_identifier: identifier,
      org_id: this.orgId,
      platform: platform(),
      arch: arch(),
      os_version: release(),
      sdk: "node",
    };

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/devices/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Device registration failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Device registration failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
      );
    }

    const data = (await response.json()) as WireDeviceRegistration;
    this.deviceId = data.id;

    return {
      id: data.id,
      deviceIdentifier: data.device_identifier,
      orgId: data.org_id,
      status: data.status,
    };
  }

  /**
   * Send a heartbeat to the control plane.
   * Requires prior registration (or manual setDeviceId).
   */
  async heartbeat(): Promise<HeartbeatResponse> {
    const id = this.getDeviceIdOrThrow();
    const seq = this.heartbeatSequence++;

    this.telemetry?.track(SPAN_NAMES.octomilControlHeartbeat, {
      [SPAN_ATTRIBUTES.heartbeatSequence]: seq,
    });

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/devices/${id}/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ device_id: id }),
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Heartbeat failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Heartbeat failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
      );
    }

    const data = (await response.json()) as WireHeartbeatResponse;
    return {
      status: data.status,
      serverTime: data.server_time,
    };
  }

  /**
   * Refresh device assignments from the control plane.
   */
  async refresh(): Promise<ControlSyncResult> {
    const id = this.getDeviceIdOrThrow();

    let response: Response;
    try {
      response = await fetch(`${this.serverUrl}/api/v1/devices/${id}/assignments`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch (err) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Assignment refresh failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Assignment refresh failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
      );
    }

    const data = (await response.json()) as WireAssignmentsResponse | DeviceAssignment[];

    // Support both wire formats: new envelope { assignments, config_version } and legacy array
    let assignments: DeviceAssignment[];
    let configVersion: string;
    let rolloutsChanged: boolean;

    if (Array.isArray(data)) {
      assignments = data;
      configVersion = "";
      rolloutsChanged = false;
    } else {
      assignments = (data.assignments ?? []).map((a) => ({
        modelId: a.model_id,
        version: a.version,
        config: a.config,
      }));
      configVersion = data.config_version ?? "";
      rolloutsChanged = data.rollouts_changed ?? false;
    }

    const assignmentsChanged = !this.assignmentsEqual(this.previousAssignments, assignments);
    const updated = assignmentsChanged || rolloutsChanged;

    this.previousAssignments = assignments;

    return {
      updated,
      configVersion,
      assignmentsChanged,
      rolloutsChanged,
      fetchedAt: new Date().toISOString(),
      assignments,
    };
  }

  private assignmentsEqual(
    a: DeviceAssignment[] | null,
    b: DeviceAssignment[],
  ): boolean {
    if (a === null) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i]!.modelId !== b[i]!.modelId || a[i]!.version !== b[i]!.version) {
        return false;
      }
    }
    return true;
  }

  /**
   * Start a periodic heartbeat at the given interval.
   * @param intervalMs Interval in milliseconds (default: 60_000).
   */
  startHeartbeat(intervalMs = 60_000): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().catch(() => {
        // best-effort — swallow heartbeat errors
      });
    }, intervalMs);
    // Allow the process to exit even if the timer is running
    if (this.heartbeatTimer && typeof this.heartbeatTimer === "object" && "unref" in this.heartbeatTimer) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Stop the periodic heartbeat.
   */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Manually set the device ID (e.g. after restoring from persistence).
   */
  setDeviceId(id: string): void {
    this.deviceId = id;
  }

  /**
   * Get the current device ID, or null if not registered.
   */
  getDeviceId(): string | null {
    return this.deviceId;
  }

  // ---- private helpers ----------------------------------------------------

  private getDeviceIdOrThrow(): string {
    if (!this.deviceId) {
      throw new OctomilError(
        "DEVICE_NOT_REGISTERED",
        "Device not registered. Call register() first.",
      );
    }
    return this.deviceId;
  }
}
