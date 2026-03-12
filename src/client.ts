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
import { ModelsClient } from "./models.js";
import { embed as embedFn } from "./embeddings.js";
import type { EmbeddingResult } from "./embeddings.js";
import type { ModelRuntime } from "./model-runtime.js";
import type { OctomilClientOptions, PullOptions, LoadOptions, PredictInput, PredictOutput, CacheInfo } from "./types.js";
import { OctomilError } from "./types.js";
import { streamInference } from "./streaming.js";
import type { StreamToken, StreamInput } from "./streaming.js";

const DEFAULT_SERVER_URL = "https://api.octomil.com";
const DEFAULT_CACHE_DIR = join(homedir(), ".octomil", "models");

/** Public telemetry facade exposed via `client.telemetry`. */
export interface TelemetryFacade {
  /** Immediately flush any queued telemetry events. */
  flush(): void;
  /** Queue a custom telemetry event. */
  track(name: string, attributes: Record<string, unknown>): void;
}

/** No-op telemetry facade returned when telemetry is disabled. */
const NOOP_TELEMETRY: TelemetryFacade = {
  flush() {},
  track() {},
};

export class OctomilClient {
  private readonly apiKey: string;
  private readonly orgId: string;
  private readonly serverUrl: string;
  private readonly cacheDir: string;
  private readonly downloader: ModelDownloader;
  private readonly cache: FileCache;
  private readonly _telemetry: TelemetryReporter | null;
  private readonly runtime: ModelRuntime | undefined;
  private readonly _loadedModels: Map<string, Model> = new Map();
  private readonly _activeDownloads: Set<string> = new Set();
  private readonly _errorModels: Set<string> = new Set();
  private _integrations?: IntegrationsClient;
  private _responses?: ResponsesClient;
  private _chat?: ChatClient;
  private _capabilities?: CapabilitiesClient;
  private _control?: ControlClient;
  private _models?: ModelsClient;

  constructor(options: OctomilClientOptions) {
    this.apiKey = options.apiKey;
    this.orgId = options.orgId;
    this.serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL;
    this.cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
    this.downloader = new ModelDownloader(this.serverUrl, this.apiKey, this.orgId);
    this.cache = new FileCache(this.cacheDir);
    this._telemetry = options.telemetry !== false
      ? new TelemetryReporter(this.serverUrl, this.apiKey, this.orgId)
      : null;
    this.runtime = options.runtime;
  }

  /**
   * Public telemetry facade.
   *
   * Returns an object with `flush()` and `track()` methods.
   * When telemetry is disabled in the constructor, returns a safe no-op facade.
   */
  get telemetry(): TelemetryFacade {
    if (!this._telemetry) return NOOP_TELEMETRY;
    const reporter = this._telemetry;
    return {
      flush() { void reporter.flush(); },
      track(name: string, attributes: Record<string, unknown>) { reporter.track(name, attributes); },
    };
  }

  get integrations(): IntegrationsClient {
    if (!this._integrations) {
      this._integrations = new IntegrationsClient(this.serverUrl, this.apiKey, this.orgId);
    }
    return this._integrations;
  }

  get responses(): ResponsesClient {
    if (!this._responses) {
      this._responses = new ResponsesClient({
        serverUrl: this.serverUrl,
        apiKey: this.apiKey,
        telemetry: this._telemetry,
      });
    }
    return this._responses;
  }

  get chat(): ChatClient {
    if (!this._chat) {
      this._chat = new ChatClient(this.serverUrl, this.apiKey, this._telemetry);
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

  get models(): ModelsClient {
    if (!this._models) {
      this._models = new ModelsClient({
        cache: this.cache,
        loadedModels: this._loadedModels,
        activeDownloads: this._activeDownloads,
        errorModels: this._errorModels,
        pullAndLoad: (modelRef, options) => this.getModel(modelRef, options),
      });
    }
    return this._models;
  }

  async pull(modelRef: string, options?: PullOptions): Promise<Model> {
    // Resolve from registry
    const pullResult = await this.downloader.resolve(modelRef, options?.version, options?.format);

    // Check cache (unless force)
    if (!options?.force && this.cache.has(modelRef, pullResult.checksum)) {
      const cachedPath = this.cache.getPath(modelRef);
      if (cachedPath) {
        this._telemetry?.track("cache_hit", { "model.id": modelRef });
        return new Model(
          modelRef, cachedPath, new InferenceEngine(), this._telemetry,
          this.runtime, pullResult.tag, pullResult.format,
        );
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

    this._telemetry?.track("model_download", { "model.id": modelRef, "model.size_bytes": sizeBytes });
    return new Model(
      modelRef, destPath, new InferenceEngine(), this._telemetry,
      this.runtime, pullResult.tag, pullResult.format,
    );
  }

  private async getModel(modelRef: string, options?: PullOptions & LoadOptions): Promise<Model> {
    const cached = this._loadedModels.get(modelRef);
    if (cached?.isLoaded) return cached;

    const model = await this.pull(modelRef, options);
    await model.load(options);
    this._loadedModels.set(modelRef, model);
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
      this._telemetry,
    );
  }

  /**
   * Close the client, releasing all loaded models and flushing telemetry.
   *
   * This is the canonical shutdown method. `dispose()` is kept as an alias
   * for backward compatibility.
   */
  close(): void {
    for (const model of this._loadedModels.values()) {
      model.dispose();
    }
    this._loadedModels.clear();
    this._telemetry?.dispose();
  }

  /** @deprecated Use `close()` instead. */
  dispose(): void {
    this.close();
  }
}
