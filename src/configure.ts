/**
 * Top-level configure() for silent device registration.
 *
 * Creates a DeviceContext, optionally triggers background device registration
 * with exponential backoff + jitter, and starts heartbeat if monitoring is
 * enabled. Registration failure never blocks local usage.
 */

import { DeviceContext } from "./device-context.js";
import { resolveHostUrl } from "./profile.js";
import {
  type SilentAuthConfig,
  validatePublishableKey,
} from "./auth-config.js";
import type { MonitoringConfig } from "./monitoring-config.js";
import { platform, arch, release, totalmem } from "node:os";
import { getSdkVersion } from "./telemetry.js";

const platformMap: Record<string, string> = {
  darwin: "macos",
  win32: "windows",
  linux: "linux",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigureOptions {
  auth?: SilentAuthConfig;
  monitoring?: MonitoringConfig;
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _deviceContext: DeviceContext | null = null;

export function getDeviceContext(): DeviceContext | null {
  return _deviceContext;
}

// ---------------------------------------------------------------------------
// configure()
// ---------------------------------------------------------------------------

export async function configure(
  options: ConfigureOptions = {},
): Promise<DeviceContext> {
  if (options.auth?.type === "publishable_key") {
    validatePublishableKey(options.auth.key);
  }

  const installationId = DeviceContext.getOrCreateInstallationId();

  const context = new DeviceContext({
    installationId,
    orgId: null, // extracted server-side from publishable key
    appId: options.auth?.type === "anonymous" ? options.auth.appId : null,
  });

  _deviceContext = context;

  const shouldRegister =
    options.auth != null && options.monitoring?.enabled === true;

  if (shouldRegister) {
    // Fire-and-forget background registration
    silentRegister(context, options).catch(() => {});
  }

  return context;
}

// ---------------------------------------------------------------------------
// Silent registration with exponential backoff + jitter
// ---------------------------------------------------------------------------

async function silentRegister(
  context: DeviceContext,
  options: ConfigureOptions,
  attempt = 0,
): Promise<void> {
  const maxAttempts = 10;
  const maxDelayMs = 300_000; // 5 minutes

  try {
    const baseUrl = resolveHostUrl({ baseUrl: options.baseUrl });
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.auth?.type === "publishable_key") {
      headers["X-API-Key"] = options.auth.key;
    } else if (options.auth?.type === "bootstrap_token") {
      headers["Authorization"] = `Bearer ${options.auth.token}`;
    }

    const osPlatformValue = platform();
    const registrationBody: Record<string, unknown> = {
      device_identifier: context.installationId,
      platform: platformMap[osPlatformValue] ?? osPlatformValue,
      app_id: context.appId,
      os_version: release(),
      sdk_version: getSdkVersion(),
      cpu_architecture: arch(),
      total_memory_mb: Math.floor(totalmem() / (1024 * 1024)),
    };
    if (osPlatformValue === "darwin") {
      registrationBody.manufacturer = "Apple";
    }

    const response = await fetch(`${baseUrl}/api/v1/devices/register`, {
      method: "POST",
      headers,
      body: JSON.stringify(registrationBody),
    });

    if (!response.ok) {
      if (response.status === 403) {
        // Non-retryable
        context._markFailed();
        return;
      }
      throw new Error(`Registration failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      device_id: string;
      access_token: string;
      expires_at: string;
    };
    context._updateRegistered(
      data.device_id,
      data.access_token,
      new Date(data.expires_at),
    );

    if (options.monitoring?.enabled) {
      startHeartbeat(context, options);
    }
  } catch {
    if (attempt < maxAttempts) {
      const baseDelay = Math.min(1000 * Math.pow(2, attempt), maxDelayMs);
      const jitter = baseDelay * 0.1 * Math.random();
      const delay = baseDelay + jitter;

      await new Promise((resolve) => setTimeout(resolve, delay));
      return silentRegister(context, options, attempt + 1);
    }

    context._markFailed();
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

function startHeartbeat(
  context: DeviceContext,
  options: ConfigureOptions,
): void {
  const intervalMs = options.monitoring?.heartbeatIntervalMs ?? 300_000;

  const timer = setInterval(async () => {
    const headers = context.authHeaders();
    if (!headers) return;

    try {
      const baseUrl = resolveHostUrl({ baseUrl: options.baseUrl });
      await fetch(`${baseUrl}/api/v1/devices/heartbeat`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          device_identifier: context.installationId,
        }),
      });
    } catch {
      // Heartbeat failures are non-fatal
    }
  }, intervalMs);

  // Allow Node.js process to exit even if heartbeat timer is running
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}
