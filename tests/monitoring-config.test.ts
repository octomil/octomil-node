import { describe, it, expect } from "vitest";
import type { MonitoringConfig } from "../src/monitoring-config.js";

describe("MonitoringConfig", () => {
  it("should define enabled property", () => {
    const config: MonitoringConfig = { enabled: true };
    expect(config.enabled).toBe(true);
  });

  it("should support optional heartbeatIntervalMs", () => {
    const config: MonitoringConfig = {
      enabled: true,
      heartbeatIntervalMs: 60_000,
    };
    expect(config.heartbeatIntervalMs).toBe(60_000);
  });

  it("should allow disabled config", () => {
    const config: MonitoringConfig = { enabled: false };
    expect(config.enabled).toBe(false);
    expect(config.heartbeatIntervalMs).toBeUndefined();
  });
});
