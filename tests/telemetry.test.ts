import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelemetryReporter } from "../src/telemetry.js";

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

  it("should send OTLP envelope with resource and events", async () => {
    const reporter = new TelemetryReporter("https://api.test.com", "key123", "org-1", 1000);
    reporter.track("inference", { "model.id": "m:v1", "inference.duration_ms": 42 });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);

    // Verify resource envelope
    expect(body.resource).toMatchObject({
      sdk: "node",
      device_id: null,
      org_id: "org-1",
    });
    expect(body.resource.sdk_version).toBeDefined();
    expect(body.resource.platform).toBeDefined();

    // Verify event structure
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe("inference.completed");
    expect(body.events[0].timestamp).toBeDefined();
    expect(body.events[0].attributes).toEqual({
      "model.id": "m:v1",
      "inference.duration_ms": 42,
    });

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

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const names = body.events.map((e: { name: string }) => e.name);

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

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.events[0].name).toBe("inference.completed");
    expect(body.events[1].name).toBe("funnel.custom_event");

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

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const event = body.events[0];

    expect(event.name).toBe("inference.completed");
    expect(event.attributes["inference.ttft_ms"]).toBe(120);
    expect(event.attributes["inference.tpot_ms"]).toBe(15.5);
    expect(event.attributes["inference.throughput_tps"]).toBe(64.5);
    expect(event.attributes["inference.modality"]).toBe("text");

    reporter.dispose();
  });
});
