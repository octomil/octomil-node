import { describe, it, expect } from "vitest";
import {
  effectiveRoutingPolicy,
  manifestEntryForCapability,
  manifestEntryForModelId,
} from "../src/manifest/types.js";
import type { AppManifest, AppModelEntry } from "../src/manifest/types.js";
import { ModelCapability } from "../src/_generated/model_capability.js";
import { DeliveryMode } from "../src/_generated/delivery_mode.js";
import { RoutingPolicy } from "../src/_generated/routing_policy.js";

const chatEntry: AppModelEntry = {
  id: "phi-4-mini",
  capability: ModelCapability.Chat,
  delivery: DeliveryMode.Managed,
  required: true,
};

const whisperEntry: AppModelEntry = {
  id: "whisper-base",
  capability: ModelCapability.Transcription,
  delivery: DeliveryMode.Bundled,
  bundledPath: "models/whisper-base.onnx",
  required: true,
};

const cloudEntry: AppModelEntry = {
  id: "gpt-4o",
  capability: ModelCapability.Chat,
  delivery: DeliveryMode.Cloud,
  required: false,
};

const manifest: AppManifest = {
  models: [chatEntry, whisperEntry, cloudEntry],
};

describe("effectiveRoutingPolicy", () => {
  it("should return localFirst for managed delivery", () => {
    expect(effectiveRoutingPolicy(chatEntry)).toBe(RoutingPolicy.LocalFirst);
  });

  it("should return localOnly for bundled delivery", () => {
    expect(effectiveRoutingPolicy(whisperEntry)).toBe(RoutingPolicy.LocalOnly);
  });

  it("should return cloudOnly for cloud delivery", () => {
    expect(effectiveRoutingPolicy(cloudEntry)).toBe(RoutingPolicy.CloudOnly);
  });

  it("should use explicit routingPolicy override", () => {
    const entry: AppModelEntry = {
      ...chatEntry,
      routingPolicy: RoutingPolicy.CloudOnly,
    };
    expect(effectiveRoutingPolicy(entry)).toBe(RoutingPolicy.CloudOnly);
  });
});

describe("manifestEntryForCapability", () => {
  it("should find entry by capability", () => {
    const entry = manifestEntryForCapability(manifest, ModelCapability.Transcription);
    expect(entry?.id).toBe("whisper-base");
  });

  it("should return first match when multiple entries share capability", () => {
    const entry = manifestEntryForCapability(manifest, ModelCapability.Chat);
    expect(entry?.id).toBe("phi-4-mini");
  });

  it("should return undefined for missing capability", () => {
    const entry = manifestEntryForCapability(manifest, ModelCapability.Embedding);
    expect(entry).toBeUndefined();
  });
});

describe("manifestEntryForModelId", () => {
  it("should find entry by model ID", () => {
    const entry = manifestEntryForModelId(manifest, "whisper-base");
    expect(entry?.capability).toBe(ModelCapability.Transcription);
  });

  it("should return undefined for unknown model ID", () => {
    const entry = manifestEntryForModelId(manifest, "nonexistent");
    expect(entry).toBeUndefined();
  });
});
