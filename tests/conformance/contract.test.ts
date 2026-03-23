/**
 * Contract conformance tests — validates generated types match octomil-contracts.
 */
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code";
import { ModelStatus } from "../../src/_generated/model_status";
import { DeviceClass } from "../../src/_generated/device_class";
import { FinishReason } from "../../src/_generated/finish_reason";
import { CompatibilityLevel } from "../../src/_generated/compatibility_level";
import { TELEMETRY_EVENTS, EVENT_REQUIRED_ATTRIBUTES } from "../../src/_generated/telemetry_events";
import { OTLP_RESOURCE_ATTRIBUTES } from "../../src/_generated/otlp_resource_attributes";
import {
  ArtifactsClient,
  ChatClient,
  DevicesClient,
  FederationClient,
  MonitoringClient,
  OctomilClient,
  ResponsesClient,
  SettingsClient,
  TelemetryReporter,
  ToolRunner,
  TrainingClient,
} from "../../src/index";

describe("Contract Conformance", () => {
  describe("ErrorCode enum", () => {
    it("has all 39 canonical error codes", () => {
      const codes = Object.values(ErrorCode);
      expect(codes).toHaveLength(39);
      expect(codes).toContain("network_unavailable");
      expect(codes).toContain("request_timeout");
      expect(codes).toContain("server_error");
      expect(codes).toContain("invalid_api_key");
      expect(codes).toContain("authentication_failed");
      expect(codes).toContain("forbidden");
      expect(codes).toContain("model_not_found");
      expect(codes).toContain("model_disabled");
      expect(codes).toContain("download_failed");
      expect(codes).toContain("checksum_mismatch");
      expect(codes).toContain("insufficient_storage");
      expect(codes).toContain("runtime_unavailable");
      expect(codes).toContain("model_load_failed");
      expect(codes).toContain("inference_failed");
      expect(codes).toContain("insufficient_memory");
      expect(codes).toContain("rate_limited");
      expect(codes).toContain("invalid_input");
      expect(codes).toContain("cancelled");
      expect(codes).toContain("unknown");
      expect(codes).toContain("training_failed");
      expect(codes).toContain("training_not_supported");
      expect(codes).toContain("weight_upload_failed");
    });
  });

  describe("ModelStatus enum", () => {
    it("has all 4 statuses", () => {
      const statuses = Object.values(ModelStatus);
      expect(statuses).toHaveLength(4);
      expect(statuses).toContain("not_cached");
      expect(statuses).toContain("downloading");
      expect(statuses).toContain("ready");
      expect(statuses).toContain("error");
    });
  });

  describe("DeviceClass enum", () => {
    it("has all 4 classes", () => {
      const classes = Object.values(DeviceClass);
      expect(classes).toHaveLength(4);
    });
  });

  describe("FinishReason enum", () => {
    it("has all 4 reasons", () => {
      const reasons = Object.values(FinishReason);
      expect(reasons).toHaveLength(4);
    });
  });

  describe("CompatibilityLevel enum", () => {
    it("has all 4 levels", () => {
      const levels = Object.values(CompatibilityLevel);
      expect(levels).toHaveLength(4);
    });
  });

  describe("Telemetry events", () => {
    it("has all 6 canonical event names", () => {
      expect(TELEMETRY_EVENTS.inferenceStarted).toBe("inference.started");
      expect(TELEMETRY_EVENTS.inferenceCompleted).toBe("inference.completed");
      expect(TELEMETRY_EVENTS.inferenceFailed).toBe("inference.failed");
      expect(TELEMETRY_EVENTS.inferenceChunkProduced).toBe("inference.chunk_produced");
      expect(TELEMETRY_EVENTS.deployStarted).toBe("deploy.started");
      expect(TELEMETRY_EVENTS.deployCompleted).toBe("deploy.completed");
    });

    it("has required attributes for each event", () => {
      expect(EVENT_REQUIRED_ATTRIBUTES["inference.started"]).toContain("model.id");
      expect(EVENT_REQUIRED_ATTRIBUTES["inference.completed"]).toContain("inference.duration_ms");
      expect(EVENT_REQUIRED_ATTRIBUTES["inference.failed"]).toContain("error.type");
    });
  });

  describe("OTLP resource attributes", () => {
    it("has all 13 keys", () => {
      const keys = Object.values(OTLP_RESOURCE_ATTRIBUTES);
      expect(keys).toHaveLength(13);
      expect(keys).toContain("octomil.install.id");
    });
  });

  describe("SDK surface", () => {
    it("exports node parity clients", () => {
      expect(ArtifactsClient).toBeTypeOf("function");
      expect(ChatClient).toBeTypeOf("function");
      expect(DevicesClient).toBeTypeOf("function");
      expect(FederationClient).toBeTypeOf("function");
      expect(MonitoringClient).toBeTypeOf("function");
      expect(OctomilClient).toBeTypeOf("function");
      expect(ResponsesClient).toBeTypeOf("function");
      expect(SettingsClient).toBeTypeOf("function");
      expect(TelemetryReporter).toBeTypeOf("function");
      expect(ToolRunner).toBeTypeOf("function");
      expect(TrainingClient).toBeTypeOf("function");
    });
  });
});
