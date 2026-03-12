import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelemetryReporter } from "../src/telemetry.js";
import type { ExportLogsServiceRequest, OtlpLogRecord } from "../src/telemetry.js";

// Mock fs/url/os imports used by getSdkVersion()
vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockReturnValue(JSON.stringify({ version: "0.1.0" })),
}));

describe("TelemetryReporter", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function parseBody(): ExportLogsServiceRequest {
    return JSON.parse(fetchMock.mock.calls[0][1].body) as ExportLogsServiceRequest;
  }

  function getLogRecords(): OtlpLogRecord[] {
    const body = parseBody();
    return body.resourceLogs[0]!.scopeLogs[0]!.logRecords;
  }

  it("should track events and queue them", () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1");
    reporter.track("model_load", { "model.id": "test:latest" });

    // Event is queued, not sent yet
    expect(fetchMock).not.toHaveBeenCalled();
    reporter.dispose();
  });

  it("should flush events to v2 endpoint on interval", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);
    reporter.track("model_load", { "model.id": "test:latest" });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test.com/api/v2/telemetry/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer key123",
        }),
      }),
    );

    reporter.dispose();
  });

  it("should send OTLP ExportLogsServiceRequest envelope", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);
    reporter.track("inference", { "model.id": "m:v1", "inference.duration_ms": 42 });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const body = parseBody();

    // Verify OTLP structure
    expect(body.resourceLogs).toHaveLength(1);
    const resourceLog = body.resourceLogs[0]!;

    // Resource attributes
    const attrs = resourceLog.resource.attributes;
    const attrMap = Object.fromEntries(attrs.map((a) => [a.key, a.value]));
    expect(attrMap["sdk"]!.stringValue).toBe("node");
    expect(attrMap["org_id"]!.stringValue).toBe("org-1");
    expect(attrMap["sdk_version"]!.stringValue).toBeDefined();
    expect(attrMap["platform"]!.stringValue).toBeDefined();

    // Scope
    const scopeLog = resourceLog.scopeLogs[0]!;
    expect(scopeLog.scope.name).toBe("@octomil/sdk");

    // Log records
    expect(scopeLog.logRecords).toHaveLength(1);
    const record = scopeLog.logRecords[0]!;
    expect(record.body!.stringValue).toBe("inference.completed");
    expect(record.timeUnixNano).toBeDefined();
    expect(Number(record.timeUnixNano)).toBeGreaterThan(0);
    expect(record.severityText).toBe("INFO");

    // Attributes as KeyValue[]
    const recordAttrs = Object.fromEntries(
      (record.attributes ?? []).map((a) => [a.key, a.value]),
    );
    expect(recordAttrs["model.id"]!.stringValue).toBe("m:v1");
    expect(recordAttrs["inference.duration_ms"]!.intValue).toBe("42");

    reporter.dispose();
  });

  it("should map v1 event types to v2 dot-notation names", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);

    reporter.track("inference", {});
    reporter.track("cache_hit", {});
    reporter.track("model_download", {});
    reporter.track("model_load", {});

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const records = getLogRecords();
    const names = records.map((r) => r.body!.stringValue);

    expect(names).toEqual([
      "inference.completed",
      "funnel.cache_hit",
      "funnel.model_download",
      "funnel.model_load",
    ]);

    reporter.dispose();
  });

  it("should pass through already-mapped dot-notation names", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);

    reporter.track("inference.completed", { "model.id": "x" });
    reporter.track("funnel.custom_event", {});

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const records = getLogRecords();
    expect(records[0]!.body!.stringValue).toBe("inference.completed");
    expect(records[1]!.body!.stringValue).toBe("funnel.custom_event");

    reporter.dispose();
  });

  it("should support new telemetry event types", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);

    reporter.track("inference.started", { "model.id": "phi-4" });
    reporter.track("inference.failed", { "model.id": "phi-4", "error.message": "OOM" });
    reporter.track("deploy.started", { "model.id": "phi-4" });
    reporter.track("deploy.completed", { "model.id": "phi-4", "deploy.target": "device" });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const records = getLogRecords();
    const names = records.map((r) => r.body!.stringValue);

    expect(names).toEqual([
      "inference.started",
      "inference.failed",
      "deploy.started",
      "deploy.completed",
    ]);

    // Verify attributes are properly encoded as OtlpKeyValue
    const failedRecord = records[1]!;
    const failedAttrs = Object.fromEntries(
      (failedRecord.attributes ?? []).map((a) => [a.key, a.value]),
    );
    expect(failedAttrs["error.message"]!.stringValue).toBe("OOM");

    reporter.dispose();
  });

  it("should flush when batch size is reached", () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 60_000, 3);

    reporter.track("event1");
    reporter.track("event2");
    expect(fetchMock).not.toHaveBeenCalled();

    reporter.track("event3"); // triggers flush at batch size 3
    expect(fetchMock).toHaveBeenCalledTimes(1);

    reporter.dispose();
  });

  it("should not flush when queue is empty", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
    reporter.dispose();
  });

  it("should clear timer on dispose", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);
    reporter.dispose();

    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should swallow fetch errors gracefully", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);

    reporter.track("event1");
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalled();
    reporter.dispose();
  });

  it("should include standard metric attributes in inference events", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);
    reporter.track("inference", {
      "model.id": "llama:7b",
      "inference.duration_ms": 500,
      "inference.ttft_ms": 120,
      "inference.tpot_ms": 15.5,
      "inference.throughput_tps": 64.5,
      "inference.modality": "text",
    });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const records = getLogRecords();
    const record = records[0]!;
    expect(record.body!.stringValue).toBe("inference.completed");

    const attrMap = Object.fromEntries(
      (record.attributes ?? []).map((a) => [a.key, a.value]),
    );
    expect(attrMap["inference.ttft_ms"]!.intValue).toBe("120");
    expect(attrMap["inference.tpot_ms"]!.doubleValue).toBe(15.5);
    expect(attrMap["inference.throughput_tps"]!.doubleValue).toBe(64.5);
    expect(attrMap["inference.modality"]!.stringValue).toBe("text");

    reporter.dispose();
  });

  it("should encode boolean attributes correctly", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);
    reporter.track("test.event", { "flag.enabled": true, "flag.disabled": false });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const records = getLogRecords();
    const attrMap = Object.fromEntries(
      (records[0]!.attributes ?? []).map((a) => [a.key, a.value]),
    );
    expect(attrMap["flag.enabled"]!.boolValue).toBe(true);
    expect(attrMap["flag.disabled"]!.boolValue).toBe(false);

    reporter.dispose();
  });
});
