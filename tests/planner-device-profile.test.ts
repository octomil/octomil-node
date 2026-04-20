import { describe, it, expect } from "vitest";
import { collectDeviceRuntimeProfile } from "../src/planner/device-profile.js";

describe("collectDeviceRuntimeProfile", () => {
  it("returns a profile with sdk set to 'node'", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(profile.sdk).toBe("node");
  });

  it("returns a non-empty sdk_version", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(profile.sdk_version).toBeTruthy();
    expect(typeof profile.sdk_version).toBe("string");
  });

  it("returns a valid platform string", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(typeof profile.platform).toBe("string");
    expect(profile.platform.length).toBeGreaterThan(0);
  });

  it("returns a valid arch string", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(typeof profile.arch).toBe("string");
    expect(profile.arch.length).toBeGreaterThan(0);
  });

  it("returns os_version as a string", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(typeof profile.os_version).toBe("string");
    expect(profile.os_version!.length).toBeGreaterThan(0);
  });

  it("returns ram_total_bytes as a positive number", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(typeof profile.ram_total_bytes).toBe("number");
    expect(profile.ram_total_bytes!).toBeGreaterThan(0);
  });

  it("returns accelerators as an array", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(Array.isArray(profile.accelerators)).toBe(true);
  });

  it("includes onnxruntime-node in installed_runtimes", async () => {
    const profile = await collectDeviceRuntimeProfile();
    expect(profile.installed_runtimes).toBeDefined();
    expect(profile.installed_runtimes!.length).toBeGreaterThanOrEqual(1);

    const onnx = profile.installed_runtimes!.find(
      (r) => r.engine === "onnxruntime-node",
    );
    expect(onnx).toBeDefined();
    expect(onnx!.available).toBe(true);
  });

  it("profile matches RuntimePlanRequest.device shape", async () => {
    const profile = await collectDeviceRuntimeProfile();

    // Verify the structure matches what RuntimePlanRequest.device expects
    expect(profile).toHaveProperty("sdk");
    expect(profile).toHaveProperty("sdk_version");
    expect(profile).toHaveProperty("platform");
    expect(profile).toHaveProperty("arch");

    // Should be usable directly in a plan request
    const request = {
      model: "phi-4-mini",
      capability: "chat" as const,
      device: profile,
    };
    expect(request.device.sdk).toBe("node");
  });
});
