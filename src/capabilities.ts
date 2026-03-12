/**
 * Capabilities namespace — device capability profiling.
 * Matches SDK_FACADE_CONTRACT.md capabilities.current().
 *
 * Detects local device class, memory, platform, available runtimes,
 * and hardware accelerators.
 */

import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CapabilityProfile {
  deviceClass: "flagship" | "high" | "mid" | "low";
  availableRuntimes: string[];
  memoryMb: number;
  storageMb: number;
  platform: string;
  accelerators: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifyDeviceClass(memoryMb: number): CapabilityProfile["deviceClass"] {
  if (memoryMb >= 32_768) return "flagship";
  if (memoryMb >= 16_384) return "high";
  if (memoryMb >= 8_192) return "mid";
  return "low";
}

function mapPlatform(p: string): string {
  switch (p) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    case "linux":
      return "linux";
    default:
      return p;
  }
}

function detectAccelerators(): string[] {
  const accelerators: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("onnxruntime-node");
    // Attempt to detect CUDA / CoreML / TensorRT availability.
    // onnxruntime-node exposes execution providers at the native level.
    // The safest heuristic: check the platform and known provider availability.
    const p = os.platform();
    if (p === "darwin") {
      accelerators.push("coreml");
    }
  } catch {
    // onnxruntime-node not available — no accelerators
  }
  return accelerators;
}

// ---------------------------------------------------------------------------
// CapabilitiesClient
// ---------------------------------------------------------------------------

export class CapabilitiesClient {
  /**
   * Return the current device's capability profile.
   */
  current(): CapabilityProfile {
    const totalMb = Math.round(os.totalmem() / (1024 * 1024));
    const freeMb = Math.round(os.freemem() / (1024 * 1024));

    return {
      deviceClass: classifyDeviceClass(totalMb),
      availableRuntimes: ["onnx"],
      memoryMb: totalMb,
      storageMb: freeMb, // Approximation — free RAM as proxy
      platform: mapPlatform(os.platform()),
      accelerators: detectAccelerators(),
    };
  }
}
