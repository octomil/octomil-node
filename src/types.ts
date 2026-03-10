// Execution providers for onnxruntime-node
export type ExecutionProvider = "cpu" | "cuda" | "tensorrt" | "coreml";

export interface OctomilClientOptions {
  apiKey: string;
  orgId: string;
  serverUrl?: string;
  cacheDir?: string;
  telemetry?: boolean;
}

export interface PullOptions {
  version?: string;
  format?: string;
  force?: boolean;
  onProgress?: (downloaded: number, total: number) => void;
}

export interface LoadOptions {
  executionProvider?: ExecutionProvider;
  graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
  interOpNumThreads?: number;
  intraOpNumThreads?: number;
}

export type TensorData = Float32Array | Int32Array | BigInt64Array | Uint8Array;

export interface NamedTensors {
  [name: string]: { data: TensorData; dims: number[] };
}

export type PredictInput =
  | NamedTensors
  | { text: string }
  | { raw: TensorData; dims: number[] };

export interface PredictOutput {
  tensors: NamedTensors;
  label?: string;
  score?: number;
  scores?: number[];
  latencyMs: number;
}

export interface PullResult {
  name: string;
  tag: string;
  downloadUrl: string;
  format: string;
  sizeBytes: number;
  checksum?: string;
}

export interface CacheEntry {
  modelRef: string;
  filePath: string;
  checksum: string;
  cachedAt: string;
  sizeBytes: number;
}

export interface CacheInfo {
  modelRef: string;
  filePath: string;
  cachedAt: string;
  sizeBytes: number;
}

export type OctomilErrorCode =
  | "MODEL_NOT_FOUND"
  | "MODEL_LOAD_FAILED"
  | "INFERENCE_FAILED"
  | "NETWORK_ERROR"
  | "INVALID_INPUT"
  | "NOT_LOADED"
  | "SESSION_DISPOSED"
  | "CACHE_ERROR"
  | "INTEGRITY_ERROR";

export class OctomilError extends Error {
  constructor(
    message: string,
    public readonly code: OctomilErrorCode,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "OctomilError";
  }
}
