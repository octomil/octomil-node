/**
 * Contract conformance tests — validates generated types match octomil-contracts.
 */
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/_generated/error_code";
import { ModelStatus } from "../../src/_generated/model_status";
import { DeviceClass } from "../../src/_generated/device_class";
import { FinishReason } from "../../src/_generated/finish_reason";
import { CompatibilityLevel } from "../../src/_generated/compatibility_level";
import { SPAN_EVENT_NAMES } from "../../src/_generated/span_event_names";
import { EVENT_REQUIRED_ATTRIBUTES } from "../../src/_generated/span_event_attributes";
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
    it("has all canonical error codes (vendored from octomil-contracts)", () => {
      // Contract is at 1.28.0 — 101 canonical codes. The catalog has been
      // growing through this session's contracts work; this assertion
      // bumps alongside contract releases (see octomil-contracts
      // enums/error_code.yaml for the truth).
      const codes = Object.values(ErrorCode);
      expect(codes.length).toBeGreaterThanOrEqual(101);
      // Core codes that must always be present
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
      // New codes added in expanded catalog
      expect(codes).toContain("insufficient_scope");
      expect(codes).toContain("missing_org_context");
      expect(codes).toContain("no_default_model");
      expect(codes).toContain("capability_not_supported");
      expect(codes).toContain("previous_response_not_found");
      expect(codes).toContain("app_not_found");
      expect(codes).toContain("capability_not_configured");
      expect(codes).toContain("app_context_conflict");
      expect(codes).toContain("invalid_model_ref");
      expect(codes).toContain("version_not_found");
      expect(codes).toContain("provider_error");
      expect(codes).toContain("upstream_provider_error");
      expect(codes).toContain("too_many_tools");
      expect(codes).toContain("unsupported_tool_calling");
      expect(codes).toContain("stream_interrupted");
      expect(codes).toContain("cloud_inference_not_allowed");
      expect(codes).toContain("hosted_tts_disabled");
      expect(codes).toContain("plan_limit_exceeded");
      expect(codes).toContain("max_tool_rounds_exceeded");
      expect(codes).toContain("incident_not_found");
      expect(codes).toContain("deployment_not_found");
      expect(codes).toContain("experiment_not_found");
      expect(codes).toContain("experiment_state_invalid");
      expect(codes).toContain("app_backgrounded");
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

  describe("Span event names (replaces legacy TELEMETRY_EVENTS)", () => {
    // telemetry_events.ts was a hand-rolled stub removed in contract sync post-#121.
    // Canonical span event names are now in span_event_names.ts (generated from contracts).
    it("has inference-related span event names", () => {
      expect(SPAN_EVENT_NAMES.firstToken).toBe("first_token");
      expect(SPAN_EVENT_NAMES.chunkProduced).toBe("chunk_produced");
      expect(SPAN_EVENT_NAMES.completed).toBe("completed");
      expect(SPAN_EVENT_NAMES.fallbackTriggered).toBe("fallback_triggered");
    });

    it("has required attributes for canonical span events", () => {
      expect(EVENT_REQUIRED_ATTRIBUTES["first_token"]).toContain("octomil.ttft_ms");
      expect(EVENT_REQUIRED_ATTRIBUTES["chunk_produced"]).toContain("octomil.chunk.index");
      expect(EVENT_REQUIRED_ATTRIBUTES["completed"]).toContain("octomil.tokens.total");
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
