/**
 * Local runner discovery for the Node SDK.
 *
 * Discovers the Python CLI's invisible local runner via:
 *   1. `OCTOMIL_LOCAL_RUNNER_URL` + `OCTOMIL_LOCAL_RUNNER_TOKEN` env vars
 *   2. `octomil local endpoint --json --show-token` subprocess fallback
 *   3. Clear setup error if neither is available
 *
 * The discovered runner exposes an OpenAI-compatible API at `/v1/chat/completions`,
 * `/v1/embeddings`, and `/v1/audio/transcriptions`.
 *
 * Security: runner tokens and URLs are NEVER printed in error messages.
 */

import { execFile } from "node:child_process";
import { OctomilError } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Resolved local runner connection info. */
export interface LocalRunnerEndpoint {
  baseUrl: string;
  token: string;
}

/** Options for local runner discovery. */
export interface LocalRunnerDiscoveryOptions {
  /** Override the CLI binary name/path. @default "octomil" */
  cliBinary?: string;
  /** Timeout in ms for CLI subprocess. @default 30_000 */
  cliTimeoutMs?: number;
  /** Model to start when discovery needs to launch the Python local runner. */
  model?: string;
  /** Engine to start when discovery needs to launch the Python local runner. */
  engine?: string;
}

/**
 * How local execution is achieved.
 *
 * - `"managed_runtime"` — The Octomil CLI's invisible local runner (Python process).
 * - `"external_endpoint"` — A user-configured local endpoint (env vars).
 * - `"hosted_gateway"` — Cloud gateway, no true local execution.
 */
export type LocalExecutionMode =
  | "managed_runtime"
  | "external_endpoint"
  | "hosted_gateway";

/**
 * Reports whether local execution is available and how it would be achieved.
 *
 * Callers can inspect this to answer "where will my inference run and why?"
 * before issuing a request.
 */
export interface LocalLifecycleStatus {
  /** Whether local execution is currently available. */
  available: boolean;
  /** The execution mode that would be used. */
  mode: LocalExecutionMode;
  /**
   * Human-readable reason when `available` is false.
   * Never contains secrets, tokens, or URLs.
   */
  reason?: string;
  /** Whether the managed runtime health check passed (only set for managed_runtime mode). */
  healthy?: boolean;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover the local runner endpoint.
 *
 * Resolution order:
 *   1. Environment variables: `OCTOMIL_LOCAL_RUNNER_URL` + `OCTOMIL_LOCAL_RUNNER_TOKEN`
 *   2. CLI subprocess: `octomil local endpoint --json --show-token`
 *
 * Throws `OctomilError` with code `RUNTIME_UNAVAILABLE` if no runner is found.
 */
export async function discoverLocalRunner(
  options?: LocalRunnerDiscoveryOptions,
): Promise<LocalRunnerEndpoint> {
  // Strategy 1: env vars
  const envEndpoint = discoverFromEnv();
  if (envEndpoint) return envEndpoint;

  // Strategy 2: CLI subprocess
  const cliEndpoint = await discoverFromCli(options);
  if (cliEndpoint) return cliEndpoint;

  // No runner found
  throw new OctomilError(
    "RUNTIME_UNAVAILABLE",
    "Local runner not available. Install the Octomil CLI (pip install octomil) " +
      "and run 'octomil local endpoint --model <model>' to start a local runner, " +
      "or set OCTOMIL_LOCAL_RUNNER_URL and OCTOMIL_LOCAL_RUNNER_TOKEN environment variables.",
  );
}

/**
 * Try to discover the local runner from environment variables.
 * Returns null if the required env vars are not set.
 */
export function discoverFromEnv(): LocalRunnerEndpoint | null {
  const url = process.env.OCTOMIL_LOCAL_RUNNER_URL;
  const token = process.env.OCTOMIL_LOCAL_RUNNER_TOKEN;

  if (!url || !token) return null;

  return {
    baseUrl: url.replace(/\/+$/, ""),
    token,
  };
}

/**
 * Try to discover the local runner via the Octomil CLI subprocess.
 * Returns null if the CLI is not installed or fails.
 */
export async function discoverFromCli(
  options?: LocalRunnerDiscoveryOptions,
): Promise<LocalRunnerEndpoint | null> {
  const binary = options?.cliBinary ?? "octomil";
  const timeoutMs = options?.cliTimeoutMs ?? 30_000;

  try {
    const args = ["local", "endpoint", "--json", "--show-token"];
    if (options?.model) {
      args.push("--model", options.model);
    }
    if (options?.engine) {
      args.push("--engine", options.engine);
    }

    const output = await execAsync(binary, args, timeoutMs);

    const parsed = JSON.parse(output) as Record<string, unknown>;
    const baseUrl =
      typeof parsed.base_url === "string" ? parsed.base_url : null;
    const token = typeof parsed.token === "string" ? parsed.token : null;

    if (!baseUrl || !token) return null;

    return {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      token,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local lifecycle status
// ---------------------------------------------------------------------------

/**
 * Check whether local execution is available and report the execution mode.
 *
 * This is a non-destructive probe — it does not start a runner, download
 * artifacts, or make any mutations. Use it to build UI status indicators
 * or gate local-only code paths.
 *
 * Resolution:
 *   1. If env vars are set (`OCTOMIL_LOCAL_RUNNER_URL` + token) -> `external_endpoint`.
 *   2. If the CLI is installed and the managed runtime responds to /health -> `managed_runtime`.
 *   3. Otherwise -> `hosted_gateway` with `available: false` and setup guidance.
 *
 * @param options - Discovery options (CLI binary path, timeout, etc.)
 * @returns A {@link LocalLifecycleStatus} describing the current state.
 */
export async function checkLocalAvailability(
  options?: LocalRunnerDiscoveryOptions,
): Promise<LocalLifecycleStatus> {
  // 1. Check for explicit external endpoint via env vars
  const envEndpoint = discoverFromEnv();
  if (envEndpoint) {
    const healthy = await localRunnerHealthCheck(envEndpoint);
    return {
      available: healthy,
      mode: "external_endpoint",
      healthy,
      reason: healthy
        ? undefined
        : "External endpoint configured but not responding to health check.",
    };
  }

  // 2. Probe the CLI-managed local runner
  const cliEndpoint = await discoverFromCli(options);
  if (cliEndpoint) {
    const healthy = await localRunnerHealthCheck(cliEndpoint);
    return {
      available: healthy,
      mode: "managed_runtime",
      healthy,
      reason: healthy
        ? undefined
        : "Managed runtime discovered but health check failed. " +
          "Run 'octomil local start' to ensure the runner is active.",
    };
  }

  // 3. No local runtime found — report hosted_gateway as fallback
  return {
    available: false,
    mode: "hosted_gateway",
    reason:
      "No local runtime available. Install the Octomil CLI " +
      "(pip install octomil) and run 'octomil local start', or set " +
      "OCTOMIL_LOCAL_RUNNER_URL and OCTOMIL_LOCAL_RUNNER_TOKEN environment variables.",
  };
}

// ---------------------------------------------------------------------------
// Local runner HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Make an authenticated POST request to the local runner.
 * Used by the local facade wrappers for responses, embeddings, and transcription.
 */
export async function localRunnerPost(
  endpoint: LocalRunnerEndpoint,
  path: string,
  body: unknown,
): Promise<Response> {
  const url = `${endpoint.baseUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.token}`,
        "User-Agent": "octomil-node/1.0",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OctomilError(
      "NETWORK_UNAVAILABLE",
      "Failed to connect to local runner. Ensure the runner is started.",
      err,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OctomilError(
      "INFERENCE_FAILED",
      `Local runner request failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`,
    );
  }

  return response;
}

/**
 * Make an authenticated multipart POST request to the local runner.
 * Do not set Content-Type here; fetch/FormData must supply the boundary.
 */
export async function localRunnerMultipartPost(
  endpoint: LocalRunnerEndpoint,
  path: string,
  body: FormData,
): Promise<Response> {
  const url = `${endpoint.baseUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "User-Agent": "octomil-node/1.0",
      },
      body,
    });
  } catch (err) {
    throw new OctomilError(
      "NETWORK_UNAVAILABLE",
      "Failed to connect to local runner. Ensure the runner is started.",
      err,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new OctomilError(
      "INFERENCE_FAILED",
      `Local runner request failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`,
    );
  }

  return response;
}

/**
 * Check if the local runner is healthy.
 */
export async function localRunnerHealthCheck(
  endpoint: LocalRunnerEndpoint,
): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint.baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function execAsync(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        encoding: "utf-8",
        env: { ...process.env },
      },
      (error, stdout, _stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
