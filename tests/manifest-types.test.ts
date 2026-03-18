import { describe, it, expect } from "vitest";
import {
  effectiveRoutingPolicy,
  manifestEntryForCapability,
  manifestEntryForModelId,
  resolveResourceBindings,
  requireResourceBinding,
  parseManifestPackage,
  parseManifestModel,
  parseClientManifest,
  packageSupportsInputModality,
  isVisionLanguagePackage,
  defaultPackage,
  packagesForPlatform,
  resourcesOfKind,
} from "../src/manifest/types.js";
import type {
  AppManifest,
  AppModelEntry,
  ManifestPackage,
  ManifestModel,
  ManifestResource,
  ResourceBindings,
} from "../src/manifest/types.js";
import { ModelCapability } from "../src/_generated/model_capability.js";
import { DeliveryMode } from "../src/_generated/delivery_mode.js";
import { RoutingPolicy } from "../src/_generated/routing_policy.js";
import { ArtifactResourceKind } from "../src/_generated/artifact_resource_kind.js";
import { Modality } from "../src/_generated/modality.js";

// ---------------------------------------------------------------------------
// App-level manifest fixtures
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Catalog manifest fixtures — multimodal VL model
// ---------------------------------------------------------------------------

const vlWeightsResource: ManifestResource = {
  kind: ArtifactResourceKind.Weights,
  uri: "https://cdn.octomil.com/models/llava-1.6/mistral-7b-q4km.gguf",
  path: "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
  sizeBytes: 4368438272,
  checksumSha256: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  required: true,
  loadOrder: 0,
};

const vlProjectorResource: ManifestResource = {
  kind: ArtifactResourceKind.Projector,
  uri: "https://cdn.octomil.com/models/llava-1.6/mmproj-model-f16.gguf",
  path: "mmproj-model-f16.gguf",
  sizeBytes: 624787456,
  checksumSha256: "b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3",
  required: true,
  loadOrder: 1,
};

const vlPackage: ManifestPackage = {
  id: "llava-1.6-mistral-7b-gguf-q4km-macos",
  artifactFormat: "gguf",
  runtimeExecutor: "llamacpp",
  platform: "macos",
  quantization: "q4_k_m",
  supportTier: "supported",
  capabilities: ["chat"],
  inputModalities: [Modality.Text, Modality.Image],
  outputModalities: [Modality.Text],
  engineConfig: { n_gpu_layers: -1, ctx_size: 4096, use_mmap: true },
  isDefault: true,
  resources: [vlWeightsResource, vlProjectorResource],
};

const textOnlyPackage: ManifestPackage = {
  id: "phi-4-mini-gguf-q4km-macos",
  artifactFormat: "gguf",
  runtimeExecutor: "llamacpp",
  platform: "macos",
  quantization: "q4_k_m",
  capabilities: ["chat"],
  inputModalities: [Modality.Text],
  outputModalities: [Modality.Text],
  isDefault: true,
  resources: [
    {
      kind: ArtifactResourceKind.Weights,
      uri: "https://cdn.octomil.com/models/phi-4-mini/phi-4-mini-q4km.gguf",
      path: "phi-4-mini-q4km.gguf",
      sizeBytes: 2_000_000_000,
      required: true,
      loadOrder: 0,
    },
  ],
};

const linuxPackage: ManifestPackage = {
  ...textOnlyPackage,
  id: "phi-4-mini-gguf-q4km-linux",
  platform: "linux",
};

const vlModel: ManifestModel = {
  id: "llava-1.6-mistral-7b",
  family: "llava",
  name: "LLaVA 1.6 Mistral 7B",
  parameterCount: "7B",
  capabilities: ["chat"],
  taskTaxonomy: ["multimodal"],
  packages: [vlPackage],
};

const textModel: ManifestModel = {
  id: "phi-4-mini",
  family: "phi",
  name: "Phi 4 Mini",
  parameterCount: "3.8B",
  capabilities: ["chat"],
  taskTaxonomy: ["text-generation"],
  packages: [textOnlyPackage, linuxPackage],
};

// ---------------------------------------------------------------------------
// effectiveRoutingPolicy
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// manifestEntryForCapability / manifestEntryForModelId
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Resource bindings
// ---------------------------------------------------------------------------

describe("resolveResourceBindings", () => {
  it("should resolve resource paths relative to base dir", () => {
    const bindings = resolveResourceBindings(
      [vlWeightsResource, vlProjectorResource],
      "/cache/llava",
    );
    expect(bindings[ArtifactResourceKind.Weights]).toBe(
      "/cache/llava/mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    );
    expect(bindings[ArtifactResourceKind.Projector]).toBe(
      "/cache/llava/mmproj-model-f16.gguf",
    );
  });

  it("should use uri when path is not specified", () => {
    const resource: ManifestResource = {
      kind: ArtifactResourceKind.Tokenizer,
      uri: "https://cdn.octomil.com/tokenizer.json",
    };
    const bindings = resolveResourceBindings([resource], "/cache");
    expect(bindings[ArtifactResourceKind.Tokenizer]).toBe(
      "https://cdn.octomil.com/tokenizer.json",
    );
  });

  it("should handle empty resource list", () => {
    const bindings = resolveResourceBindings([], "/cache");
    expect(Object.keys(bindings)).toHaveLength(0);
  });
});

describe("requireResourceBinding", () => {
  it("should return path for present resource", () => {
    const bindings: ResourceBindings = {
      [ArtifactResourceKind.Weights]: "/cache/model.gguf",
    };
    expect(requireResourceBinding(bindings, ArtifactResourceKind.Weights)).toBe(
      "/cache/model.gguf",
    );
  });

  it("should throw for missing resource", () => {
    const bindings: ResourceBindings = {};
    expect(() =>
      requireResourceBinding(bindings, ArtifactResourceKind.Projector),
    ).toThrow("Required resource binding missing: projector");
  });
});

// ---------------------------------------------------------------------------
// Package query helpers
// ---------------------------------------------------------------------------

describe("packageSupportsInputModality", () => {
  it("should return true for supported modality", () => {
    expect(packageSupportsInputModality(vlPackage, Modality.Text)).toBe(true);
    expect(packageSupportsInputModality(vlPackage, Modality.Image)).toBe(true);
  });

  it("should return false for unsupported modality", () => {
    expect(packageSupportsInputModality(vlPackage, Modality.Audio)).toBe(false);
    expect(packageSupportsInputModality(textOnlyPackage, Modality.Image)).toBe(false);
  });
});

describe("isVisionLanguagePackage", () => {
  it("should identify VL package with text+image input", () => {
    expect(isVisionLanguagePackage(vlPackage)).toBe(true);
  });

  it("should not identify text-only package as VL", () => {
    expect(isVisionLanguagePackage(textOnlyPackage)).toBe(false);
  });
});

describe("defaultPackage", () => {
  it("should return the is_default package", () => {
    const pkg = defaultPackage(vlModel);
    expect(pkg?.id).toBe("llava-1.6-mistral-7b-gguf-q4km-macos");
  });

  it("should fall back to first package if no is_default", () => {
    const model: ManifestModel = {
      ...textModel,
      packages: [
        { ...textOnlyPackage, isDefault: undefined },
        { ...linuxPackage, isDefault: undefined },
      ],
    };
    const pkg = defaultPackage(model);
    expect(pkg?.id).toBe("phi-4-mini-gguf-q4km-macos");
  });

  it("should return undefined for model with no packages", () => {
    const model: ManifestModel = { ...textModel, packages: [] };
    expect(defaultPackage(model)).toBeUndefined();
  });
});

describe("packagesForPlatform", () => {
  it("should filter packages by platform", () => {
    const macos = packagesForPlatform(textModel, "macos");
    expect(macos).toHaveLength(1);
    expect(macos[0]!.id).toBe("phi-4-mini-gguf-q4km-macos");

    const linux = packagesForPlatform(textModel, "linux");
    expect(linux).toHaveLength(1);
    expect(linux[0]!.id).toBe("phi-4-mini-gguf-q4km-linux");
  });

  it("should return empty array for unknown platform", () => {
    expect(packagesForPlatform(textModel, "windows")).toHaveLength(0);
  });
});

describe("resourcesOfKind", () => {
  it("should find resources by kind", () => {
    const weights = resourcesOfKind(vlPackage, ArtifactResourceKind.Weights);
    expect(weights).toHaveLength(1);
    expect(weights[0]!.kind).toBe(ArtifactResourceKind.Weights);

    const projectors = resourcesOfKind(vlPackage, ArtifactResourceKind.Projector);
    expect(projectors).toHaveLength(1);
    expect(projectors[0]!.kind).toBe(ArtifactResourceKind.Projector);
  });

  it("should return empty array for absent kind", () => {
    const adapters = resourcesOfKind(vlPackage, ArtifactResourceKind.Adapter);
    expect(adapters).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parsing helpers (snake_case JSON -> camelCase)
// ---------------------------------------------------------------------------

describe("parseManifestPackage", () => {
  it("should parse VL package from snake_case JSON", () => {
    const raw = {
      id: "llava-1.6-mistral-7b-gguf-q4km-macos",
      artifact_format: "gguf",
      runtime_executor: "llamacpp",
      platform: "macos",
      quantization: "q4_k_m",
      support_tier: "supported",
      capabilities: ["chat"],
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      engine_config: { n_gpu_layers: -1, ctx_size: 4096, use_mmap: true },
      is_default: true,
      resources: [
        {
          kind: "weights",
          uri: "https://cdn.octomil.com/models/llava/weights.gguf",
          path: "weights.gguf",
          size_bytes: 4368438272,
          checksum_sha256: "abcdef",
          required: true,
          load_order: 0,
        },
        {
          kind: "projector",
          uri: "https://cdn.octomil.com/models/llava/mmproj.gguf",
          path: "mmproj.gguf",
          size_bytes: 624787456,
          required: true,
          load_order: 1,
        },
      ],
    };

    const pkg = parseManifestPackage(raw);

    expect(pkg.id).toBe("llava-1.6-mistral-7b-gguf-q4km-macos");
    expect(pkg.artifactFormat).toBe("gguf");
    expect(pkg.runtimeExecutor).toBe("llamacpp");
    expect(pkg.platform).toBe("macos");
    expect(pkg.inputModalities).toEqual([Modality.Text, Modality.Image]);
    expect(pkg.outputModalities).toEqual([Modality.Text]);
    expect(pkg.engineConfig).toEqual({ n_gpu_layers: -1, ctx_size: 4096, use_mmap: true });
    expect(pkg.resources).toHaveLength(2);
    expect(pkg.resources[0]!.kind).toBe(ArtifactResourceKind.Weights);
    expect(pkg.resources[0]!.sizeBytes).toBe(4368438272);
    expect(pkg.resources[1]!.kind).toBe(ArtifactResourceKind.Projector);
    expect(pkg.resources[1]!.loadOrder).toBe(1);
  });
});

describe("parseManifestModel", () => {
  it("should parse model with task_taxonomy from snake_case JSON", () => {
    const raw = {
      id: "llava-1.6-mistral-7b",
      family: "llava",
      name: "LLaVA 1.6 Mistral 7B",
      parameter_count: "7B",
      capabilities: ["chat"],
      task_taxonomy: ["multimodal"],
      packages: [],
    };

    const model = parseManifestModel(raw);

    expect(model.id).toBe("llava-1.6-mistral-7b");
    expect(model.family).toBe("llava");
    expect(model.parameterCount).toBe("7B");
    expect(model.taskTaxonomy).toEqual(["multimodal"]);
    expect(model.packages).toHaveLength(0);
  });
});

describe("parseClientManifest", () => {
  it("should parse a complete client manifest from contracts fixture format", () => {
    const raw = {
      version: "2026-03-18T00:00:00Z",
      generated_at: "2026-03-18T01:00:00Z",
      models: [
        {
          id: "llava-1.6-mistral-7b",
          family: "llava",
          name: "LLaVA 1.6 Mistral 7B",
          parameter_count: "7B",
          capabilities: ["chat"],
          task_taxonomy: ["multimodal"],
          packages: [
            {
              id: "llava-pkg-1",
              artifact_format: "gguf",
              runtime_executor: "llamacpp",
              platform: "macos",
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              engine_config: { n_gpu_layers: -1 },
              resources: [
                { kind: "weights", uri: "https://cdn.octomil.com/weights.gguf", path: "weights.gguf", required: true, load_order: 0 },
                { kind: "projector", uri: "https://cdn.octomil.com/mmproj.gguf", path: "mmproj.gguf", required: true, load_order: 1 },
              ],
            },
          ],
        },
      ],
    };

    const cm = parseClientManifest(raw);

    expect(cm.version).toBe("2026-03-18T00:00:00Z");
    expect(cm.generatedAt).toBe("2026-03-18T01:00:00Z");
    expect(cm.models).toHaveLength(1);

    const model = cm.models[0]!;
    expect(model.id).toBe("llava-1.6-mistral-7b");
    expect(model.taskTaxonomy).toEqual(["multimodal"]);

    const pkg = model.packages[0]!;
    expect(pkg.inputModalities).toEqual([Modality.Text, Modality.Image]);
    expect(pkg.outputModalities).toEqual([Modality.Text]);
    expect(pkg.engineConfig).toEqual({ n_gpu_layers: -1 });
    expect(pkg.resources).toHaveLength(2);
    expect(pkg.resources[0]!.kind).toBe(ArtifactResourceKind.Weights);
    expect(pkg.resources[1]!.kind).toBe(ArtifactResourceKind.Projector);
  });
});

// ---------------------------------------------------------------------------
// VL model entry parsing with required modality fields
// ---------------------------------------------------------------------------

describe("VL model entry parsing", () => {
  it("should correctly represent a VL model with text+image input and text output", () => {
    const pkg = vlPackage;

    // Verify required fields are present and correct
    expect(pkg.inputModalities).toEqual([Modality.Text, Modality.Image]);
    expect(pkg.outputModalities).toEqual([Modality.Text]);

    // Verify it's identified as VL
    expect(isVisionLanguagePackage(pkg)).toBe(true);

    // Verify it has both weights and projector resources
    const weights = resourcesOfKind(pkg, ArtifactResourceKind.Weights);
    const projectors = resourcesOfKind(pkg, ArtifactResourceKind.Projector);
    expect(weights).toHaveLength(1);
    expect(projectors).toHaveLength(1);
  });

  it("should have engine_config for executor-specific hints", () => {
    expect(vlPackage.engineConfig).toBeDefined();
    expect(vlPackage.engineConfig!["n_gpu_layers"]).toBe(-1);
    expect(vlPackage.engineConfig!["ctx_size"]).toBe(4096);
    expect(vlPackage.engineConfig!["use_mmap"]).toBe(true);
  });

  it("should round-trip VL model through parse functions", () => {
    // Simulate the JSON that would come from the server
    const rawManifest = {
      version: "1.0.0",
      generated_at: "2026-03-18T00:00:00Z",
      models: [
        {
          id: "llava-1.6-mistral-7b",
          family: "llava",
          name: "LLaVA 1.6 Mistral 7B",
          parameter_count: "7B",
          capabilities: ["chat"],
          task_taxonomy: ["multimodal"],
          packages: [
            {
              id: "llava-1.6-mistral-7b-gguf-q4km-macos",
              artifact_format: "gguf",
              runtime_executor: "llamacpp",
              platform: "macos",
              quantization: "q4_k_m",
              support_tier: "supported",
              capabilities: ["chat"],
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              engine_config: { n_gpu_layers: -1, ctx_size: 4096, use_mmap: true },
              is_default: true,
              resources: [
                {
                  kind: "weights",
                  uri: "https://cdn.octomil.com/models/llava/weights.gguf",
                  path: "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
                  size_bytes: 4368438272,
                  checksum_sha256: "a1b2c3d4",
                  required: true,
                  load_order: 0,
                },
                {
                  kind: "projector",
                  uri: "https://cdn.octomil.com/models/llava/mmproj.gguf",
                  path: "mmproj-model-f16.gguf",
                  size_bytes: 624787456,
                  checksum_sha256: "b2c3d4e5",
                  required: true,
                  load_order: 1,
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = parseClientManifest(rawManifest);
    const model = parsed.models[0]!;
    const pkg = model.packages[0]!;

    // Verify the full round-trip
    expect(model.taskTaxonomy).toEqual(["multimodal"]);
    expect(pkg.inputModalities).toEqual([Modality.Text, Modality.Image]);
    expect(pkg.outputModalities).toEqual([Modality.Text]);
    expect(isVisionLanguagePackage(pkg)).toBe(true);

    // Resolve resource bindings
    const bindings = resolveResourceBindings(pkg.resources, "/cache/llava");
    expect(bindings[ArtifactResourceKind.Weights]).toBe(
      "/cache/llava/mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    );
    expect(bindings[ArtifactResourceKind.Projector]).toBe(
      "/cache/llava/mmproj-model-f16.gguf",
    );
  });
});
