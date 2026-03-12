import { join } from "node:path";
import { homedir } from "node:os";
import { Model } from "./model.js";
import { ModelDownloader } from "./model-downloader.js";
import { FileCache } from "./file-cache.js";
import { InferenceEngine } from "./inference-engine.js";
import { TelemetryReporter } from "./telemetry.js";
import { computeFileHash } from "./integrity.js";
import { IntegrationsClient } from "./integrations.js";
import { ResponsesClient } from "./responses.js";
import { ChatClient } from "./chat.js";
import { CapabilitiesClient } from "./capabilities.js";
import { ControlClient } from "./control.js";
import { embed as embedFn } from "./embeddings.js";
import type { EmbeddingResult } from "./embeddings.js";
import type { OctomilClientOptions, PullOptions, LoadOptions, PredictInput, PredictOutput, CacheInfo } from "./types.js";
import { OctomilError } from "./types.js";
import { streamInference } from "./streaming.js";
import type { StreamToken, StreamInput } from "./streaming.js";

const DEFAULT_SERVER_URL = "https://api.octomil.com";
const DEFAULT_CACHE_DIR = join(homedir(), ".octomil", "models");

export class OctomilClient {
  private readonly apiKey: string;
  private readonly orgId: string;
  private readonly serverUrl: string;
  private readonly cacheDir: string;
  private readonly downloader: ModelDownloader;
  private readonly cache: FileCache;
  private readonly telemetry: TelemetryReporter | null;
  private readonly models: Map<string, Model> = new Map();
  private _integrations?: IntegrationsClient;
  private _responses?: ResponsesClient;
  private _chat?: ChatClient;
  private _capabilities?: CapabilitiesClient;
  private _control?: ControlClient;

  constructor(options: OctomilClientOptions) {
    this.apiKey = options.apiKey;
    this.orgId = options.orgId;
    this.serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.downloader = new ModelDownloader(this.serverUrl, this.apiKey, this.orgId);
    this.cache = new FileCache(this.cacheDir);
    this.telemetry = options.telemetry !== false
      ? new TelemetryReporter(this.serverUrl, this.apiKey, this.orgId)
      : null;
  }

  get integrations(): IntegrationsClient {
    if (!this._integrations) {
      this._integrations = new IntegrationsClient(this.serverUrl, this.apiKey, this.orgId);
    }
    return this._integrations;
  }

  get responses(): ResponsesClient {
    if (!this._responses) {
      this._responses = new ResponsesClient({ serverUrl: this.serverUrl, apiKey: this.apiKey });
    }
    return this._responses;
  }

  get chat(): ChatClient {
    if (!this._chat) {
      this._chat = new ChatClient(this.serverUrl, this.apiKey);
    }
    return this._chat;
  }

  get capabilities(): CapabilitiesClient {
    if (!this._capabilities) {
      this._capabilities = new CapabilitiesClient();
    }
    return this._capabilities;
  }

  get control(): ControlClient {
    if (!this._control) {
      this._control = new ControlClient(this.serverUrl, this.apiKey, this.orgId);
    }
    return this._control;
  }

  async pull(modelRef: string, options?: PullOptions): Promise<Model> {
    // Resolve from registry
    const pullResult = await this.downloader.resolve(modelRef, options?.version, options?.format);

    // Check cache (unless force)
    if (!options?.force && this.cache.has(modelRef, pullResult.checksum)) {
      const cachedPath = this.cache.getPath(modelRef);
      if (cachedPath) {
        this.telemetry?.track("cache_hit", { "model.id": modelRef });
        return new Model(modelRef, cachedPath, new InferenceEngine(), this.telemetry);
      }
    }

    // Download
    const destDir = join(this.cacheDir, ...modelRef.split(":"));
    const destPath = join(destDir, "model.onnx");
    await this.downloader.download(pullResult.downloadUrl, destPath, options?.onProgress);

    // Verify integrity
    if (pullResult.checksum) {
      const hash = await computeFileHash(destPath);
      if (hash !== pullResult.checksum) {
        throw new OctomilError(
          `Integrity check failed for ${modelRef}`,
          "INTEGRITY_ERROR",
        );
      }
    }

    // Register in cache
    const sizeBytes = pullResult.sizeBytes;
    this.cache.register({
      modelRef,
      filePath: destPath,
      checksum: pullResult.checksum ?? "",
      cachedAt: new Date().toISOString(),
      sizeBytes,
    });

    this.telemetry?.track("model_download", { "model.id": modelRef, "model.size_bytes": sizeBytes });
    return new Model(modelRef, destPath, new InferenceEngine(), this.telemetry);
  }

  private async getModel(modelRef: string, options?: PullOptions & LoadOptions): Promise<Model> {
    const cached = this.models.get(modelRef);
    if (cached?.isLoaded) return cached;

    const model = await this.pull(modelRef, options);
    await model.load(options);
    this.models.set(modelRef, model);
    return model;
  }

  async predict(modelRef: string, input: PredictInput, options?: PullOptions & LoadOptions): Promise<PredictOutput> {
    const model = await this.getModel(modelRef, options);
    return model.predict(input);
  }

  async listCached(): Promise<CacheInfo[]> {
    return this.cache.list();
  }

  async removeCache(modelRef: string): Promise<void> {
    this.cache.remove(modelRef);
  }

  async embed(
    modelId: string,
    input: string | string[],
    signal?: AbortSignal,
  ): Promise<EmbeddingResult> {
    return embedFn(
      { serverUrl: this.serverUrl, apiKey: this.apiKey },
      modelId,
      input,
      signal,
    );
  }

  /**
   * Stream tokens from the cloud inference endpoint via SSE.
   *
   * @param modelId - Model identifier (e.g. `"phi-4-mini"`).
   * @param input - A string prompt or array of chat messages.
   * @param parameters - Optional generation parameters.
   */
  async *streamPredict(
    modelId: string,
    input: StreamInput,
    parameters?: Record<string, unknown>,
  ): AsyncGenerator<StreamToken> {
    yield* streamInference(
      { serverUrl: this.serverUrl, apiKey: this.apiKey },
      modelId,
      input,
      parameters,
    );
  }

  dispose(): void {
    for (const model of this.models.values()) {
      model.dispose();
    }
    this.models.clear();
    this.telemetry?.dispose();
  }
}
