/**
 * Control namespace — device registration, heartbeat, and assignment refresh.
 * Matches SDK_FACADE_CONTRACT.md control.register(), control.heartbeat(),
 * control.refresh(), control.startHeartbeat(), control.stopHeartbeat().
 */

import { OctomilError } from "./types.js";
import { hostname, platform, arch, release } from "node:os";

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

// ---------------------------------------------------------------------------
// ControlClient
// ---------------------------------------------------------------------------

export class ControlClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly orgId: string;
  private deviceId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(serverUrl: string, apiKey: string, orgId: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.orgId = orgId;
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
        `Device registration failed: ${String(err)}`,
        "NETWORK_UNAVAILABLE",
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        `Device registration failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
        "NETWORK_UNAVAILABLE",
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
        `Heartbeat failed: ${String(err)}`,
        "NETWORK_UNAVAILABLE",
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        `Heartbeat failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
        "NETWORK_UNAVAILABLE",
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
  async refresh(): Promise<DeviceAssignment[]> {
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
        `Assignment refresh failed: ${String(err)}`,
        "NETWORK_UNAVAILABLE",
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new OctomilError(
        `Assignment refresh failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
        "NETWORK_UNAVAILABLE",
      );
    }

    return (await response.json()) as DeviceAssignment[];
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
        "Device not registered. Call register() first.",
        "INVALID_INPUT",
      );
    }
    return this.deviceId;
  }
}
