/**
 * Collect device runtime profile for planner requests.
 *
 * Mirrors the Python SDK's `collect_device_runtime_profile()` function,
 * adapted for the Node.js environment.
 */

import type { DeviceRuntimeProfile } from "./types.js";

/** Return the @octomil/sdk version from package.json. */
function getSdkVersion(): string {
  // We cannot do a synchronous import of package.json in ESM,
  // so we hardcode the version and update it at release time.
  // This matches the pattern used by other parts of the SDK.
  return "1.3.1";
}

/**
 * Collect a device runtime profile describing the current Node.js environment.
 *
 * This is the Node.js equivalent of the Python SDK's
 * `collect_device_runtime_profile()`.
 */
export async function collectDeviceRuntimeProfile(): Promise<DeviceRuntimeProfile> {
  const os = await import("node:os");

  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  const totalMem = os.totalmem();

  const accelerators: string[] = [];

  // Detect Apple Silicon / Metal
  if (platform === "darwin" && arch === "arm64") {
    accelerators.push("metal");
  }

  return {
    sdk: "node",
    sdk_version: getSdkVersion(),
    platform,
    arch,
    os_version: release,
    chip: undefined,
    ram_total_bytes: totalMem,
    gpu_core_count: undefined,
    accelerators,
    installed_runtimes: [
      {
        engine: "onnxruntime-node",
        available: true,
      },
    ],
    supported_gate_codes: [],
  };
}
