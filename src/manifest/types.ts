/**
 * Manifest types — AppManifest, AppModelEntry, AppRoutingPolicy,
 * ClientManifest, ManifestModel, ManifestPackage, ManifestResource.
 *
 * Pure data types with no runtime or engine dependencies.
 */

import { ModelCapability } from "../_generated/model_capability.js";
import { DeliveryMode } from "../_generated/delivery_mode.js";
import { RoutingPolicy } from "../_generated/routing_policy.js";
import { ArtifactResourceKind } from "../_generated/artifact_resource_kind.js";
import { Modality } from "../_generated/modality.js";

// Re-export for consumer convenience
export { ArtifactResourceKind } from "../_generated/artifact_resource_kind.js";
export { Modality } from "../_generated/modality.js";

// ---------------------------------------------------------------------------
// AppRoutingPolicy (re-export RoutingPolicy with a manifest-local alias)
// ---------------------------------------------------------------------------

export type AppRoutingPolicy = RoutingPolicy;
export { RoutingPolicy as AppRoutingPolicyEnum } from "../_generated/routing_policy.js";

// ---------------------------------------------------------------------------
// Task taxonomy (replaces the old model_family.modalities misnomer)
// ---------------------------------------------------------------------------

export type TaskTaxonomy =
  | "text-generation"
  | "text-embedding"
  | "audio-transcription"
  | "image-classification"
  | "multimodal";

// ---------------------------------------------------------------------------
// ManifestResource — individual file within a package
// ---------------------------------------------------------------------------

export type ResourceCompression = "none" | "gzip" | "zstd" | "lz4";

export interface ManifestResource {
  readonly kind: ArtifactResourceKind;
  readonly uri: string;
  readonly path?: string;
  readonly sizeBytes?: number;
  readonly checksumSha256?: string;
  readonly required?: boolean;
  readonly loadOrder?: number;
  readonly compression?: ResourceCompression;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// ResourceBindings — maps resource kinds to resolved local file paths
// ---------------------------------------------------------------------------

/**
 * Maps each ArtifactResourceKind present in a package to the resolved
 * local file path. Built after download completes.
 */
export type ResourceBindings = Partial<Record<ArtifactResourceKind, string>>;

/**
 * Resolve resource bindings from a list of ManifestResource entries
 * and a base directory where files are stored.
 */
export function resolveResourceBindings(
  resources: readonly ManifestResource[],
  baseDir: string,
): ResourceBindings {
  const bindings: ResourceBindings = {};
  for (const r of resources) {
    const filePath = r.path ? `${baseDir}/${r.path}` : r.uri;
    bindings[r.kind] = filePath;
  }
  return bindings;
}

/**
 * Get the file path for a specific resource kind from bindings.
 * Throws if the resource is not present.
 */
export function requireResourceBinding(
  bindings: ResourceBindings,
  kind: ArtifactResourceKind,
): string {
  const path = bindings[kind];
  if (!path) {
    throw new Error(`Required resource binding missing: ${kind}`);
  }
  return path;
}

// ---------------------------------------------------------------------------
// ManifestPackage — artifact package within a model entry
// ---------------------------------------------------------------------------

export interface ManifestPackage {
  readonly id: string;
  readonly artifactFormat: string;
  readonly runtimeExecutor: string;
  readonly platform: string;
  readonly quantization?: string;
  readonly supportTier?: string;
  readonly capabilities?: readonly string[];
  readonly inputModalities: readonly Modality[];
  readonly outputModalities: readonly Modality[];
  readonly engineConfig?: Readonly<Record<string, unknown>>;
  readonly isDefault?: boolean;
  readonly resources: readonly ManifestResource[];
}

// ---------------------------------------------------------------------------
// ManifestModel — resolved model entry from the client manifest
// ---------------------------------------------------------------------------

export interface ManifestModel {
  readonly id: string;
  readonly family: string;
  readonly name: string;
  readonly parameterCount: string;
  readonly capabilities?: readonly string[];
  readonly taskTaxonomy?: readonly TaskTaxonomy[];
  readonly defaultQuantization?: string;
  readonly packages: readonly ManifestPackage[];
}

// ---------------------------------------------------------------------------
// ClientManifest — top-level catalog manifest consumed by SDKs
// ---------------------------------------------------------------------------

export interface ClientManifest {
  readonly version: string;
  readonly generatedAt: string;
  readonly models: readonly ManifestModel[];
}

// ---------------------------------------------------------------------------
// Parsing helpers — convert snake_case JSON to camelCase types
// ---------------------------------------------------------------------------

export function parseManifestResource(raw: Record<string, unknown>): ManifestResource {
  return {
    kind: raw["kind"] as ArtifactResourceKind,
    uri: raw["uri"] as string,
    path: raw["path"] as string | undefined,
    sizeBytes: raw["size_bytes"] as number | undefined,
    checksumSha256: raw["checksum_sha256"] as string | undefined,
    required: raw["required"] as boolean | undefined,
    loadOrder: raw["load_order"] as number | undefined,
    compression: raw["compression"] as ResourceCompression | undefined,
    metadata: raw["metadata"] as Record<string, unknown> | undefined,
  };
}

export function parseManifestPackage(raw: Record<string, unknown>): ManifestPackage {
  const rawResources = (raw["resources"] as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: raw["id"] as string,
    artifactFormat: raw["artifact_format"] as string,
    runtimeExecutor: raw["runtime_executor"] as string,
    platform: raw["platform"] as string,
    quantization: raw["quantization"] as string | undefined,
    supportTier: raw["support_tier"] as string | undefined,
    capabilities: raw["capabilities"] as string[] | undefined,
    inputModalities: raw["input_modalities"] as Modality[],
    outputModalities: raw["output_modalities"] as Modality[],
    engineConfig: raw["engine_config"] as Record<string, unknown> | undefined,
    isDefault: raw["is_default"] as boolean | undefined,
    resources: rawResources.map(parseManifestResource),
  };
}

export function parseManifestModel(raw: Record<string, unknown>): ManifestModel {
  const rawPackages = (raw["packages"] as Record<string, unknown>[] | undefined) ?? [];
  return {
    id: raw["id"] as string,
    family: raw["family"] as string,
    name: raw["name"] as string,
    parameterCount: raw["parameter_count"] as string,
    capabilities: raw["capabilities"] as string[] | undefined,
    taskTaxonomy: raw["task_taxonomy"] as TaskTaxonomy[] | undefined,
    defaultQuantization: raw["default_quantization"] as string | undefined,
    packages: rawPackages.map(parseManifestPackage),
  };
}

export function parseClientManifest(raw: Record<string, unknown>): ClientManifest {
  const rawModels = (raw["models"] as Record<string, unknown>[]) ?? [];
  return {
    version: raw["version"] as string,
    generatedAt: raw["generated_at"] as string,
    models: rawModels.map(parseManifestModel),
  };
}

// ---------------------------------------------------------------------------
// Package query helpers
// ---------------------------------------------------------------------------

/**
 * Check if a package supports a given input modality.
 */
export function packageSupportsInputModality(
  pkg: ManifestPackage,
  modality: Modality,
): boolean {
  return pkg.inputModalities.includes(modality);
}

/**
 * Check if a package is a vision-language (VL) model.
 * VL models accept both text and image input.
 */
export function isVisionLanguagePackage(pkg: ManifestPackage): boolean {
  return (
    pkg.inputModalities.includes(Modality.Text) &&
    pkg.inputModalities.includes(Modality.Image)
  );
}

/**
 * Get the default package from a model's package list.
 */
export function defaultPackage(model: ManifestModel): ManifestPackage | undefined {
  return model.packages.find((p) => p.isDefault) ?? model.packages[0];
}

/**
 * Find packages matching a specific platform.
 */
export function packagesForPlatform(
  model: ManifestModel,
  platform: string,
): ManifestPackage[] {
  return model.packages.filter((p) => p.platform === platform);
}

/**
 * Get all resources of a specific kind from a package.
 */
export function resourcesOfKind(
  pkg: ManifestPackage,
  kind: ArtifactResourceKind,
): ManifestResource[] {
  return pkg.resources.filter((r) => r.kind === kind);
}

// ---------------------------------------------------------------------------
// AppModelEntry (app-level manifest entry, distinct from catalog manifest)
// ---------------------------------------------------------------------------

export interface AppModelEntry {
  readonly id: string;
  readonly capability: ModelCapability;
  readonly delivery: DeliveryMode;
  readonly routingPolicy?: AppRoutingPolicy;
  /** Relative or absolute path for bundled models. */
  readonly bundledPath?: string;
  readonly required: boolean;
}

/** Derive the effective routing policy from an explicit override or the delivery mode. */
export function effectiveRoutingPolicy(entry: AppModelEntry): RoutingPolicy {
  if (entry.routingPolicy) return entry.routingPolicy;
  switch (entry.delivery) {
    case DeliveryMode.Bundled:
      return RoutingPolicy.LocalOnly;
    case DeliveryMode.Managed:
      return RoutingPolicy.LocalFirst;
    case DeliveryMode.Cloud:
      return RoutingPolicy.CloudOnly;
  }
}

// ---------------------------------------------------------------------------
// AppManifest
// ---------------------------------------------------------------------------

export interface AppManifest {
  readonly models: readonly AppModelEntry[];
}

/** Find the first entry matching a capability. */
export function manifestEntryForCapability(
  manifest: AppManifest,
  capability: ModelCapability,
): AppModelEntry | undefined {
  return manifest.models.find((e) => e.capability === capability);
}

/** Find an entry by model ID. */
export function manifestEntryForModelId(
  manifest: AppManifest,
  id: string,
): AppModelEntry | undefined {
  return manifest.models.find((e) => e.id === id);
}
