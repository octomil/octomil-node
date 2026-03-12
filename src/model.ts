import type { InferenceEngine } from "./inference-engine.js";
import type { ModelRuntime } from "./model-runtime.js";
import type { RoutingClient, DeviceCapabilities } from "./routing.js";
import type { TelemetryReporter } from "./telemetry.js";
import type { LoadOptions, PredictInput, PredictOutput } from "./types.js";
import { OctomilError } from "./types.js";

export class Model {
  private engine: InferenceEngine;
  private telemetry: TelemetryReporter | null;
  private session: unknown = null;
  private _inputNames: string[] = [];
  private _outputNames: string[] = [];
  private _activeProvider: string = "";
  private _disposed = false;
  private _runtime: ModelRuntime | null = null;

  /** Optional routing client for device/cloud inference decisions. */
  private _routingClient: RoutingClient | null = null;
  private _deviceCaps: DeviceCapabilities | null = null;
  private _modelParams = 0;
  private _modelSizeMb = 0;

  constructor(
    public readonly modelRef: string,
    public readonly filePath: string,
    engine: InferenceEngine,
    telemetry: TelemetryReporter | null,
    runtime?: ModelRuntime,
  ) {
    this.engine = engine;
    this.telemetry = telemetry;
    this._runtime = runtime ?? null;
  }

  /**
   * Enable cloud routing for this model.
   *
   * When configured, each `predict()` call first consults the routing API.
   * If the server recommends cloud execution, inference runs server-side.
   * On any failure, falls back to local ONNX inference silently.
   */
  configureRouting(
    routingClient: RoutingClient,
    deviceCaps: DeviceCapabilities,
    modelParams = 0,
    modelSizeMb = 0,
  ): void {
    this._routingClient = routingClient;
    this._deviceCaps = deviceCaps;
    this._modelParams = modelParams;
    this._modelSizeMb = modelSizeMb;
  }

  /** Disable cloud routing, reverting to local-only inference. */
  disableRouting(): void {
    this._routingClient = null;
    this._deviceCaps = null;
  }

  get isLoaded(): boolean {
    return this.session !== null && !this._disposed;
  }

  get activeProvider(): string {
    return this._activeProvider;
  }

  get inputNames(): string[] {
    return [...this._inputNames];
  }

  get outputNames(): string[] {
    return [...this._outputNames];
  }

  async load(options?: LoadOptions): Promise<this> {
    if (this._disposed) {
      throw new OctomilError("Model has been disposed", "SESSION_DISPOSED");
    }
    const start = performance.now();
    const result = await this.engine.createSession(this.filePath, options);
    this.session = result.session;
    this._inputNames = result.inputNames;
    this._outputNames = result.outputNames;
    this._activeProvider = result.activeProvider;
    const durationMs = performance.now() - start;
    this.telemetry?.track("model_load", {
      "model.id": this.modelRef,
      "duration_ms": durationMs,
      "inference.provider": this._activeProvider,
    });
    return this;
  }

  async predict(input: PredictInput): Promise<PredictOutput> {
    if (!this.isLoaded) {
      throw new OctomilError("Model not loaded. Call load() first.", "NOT_LOADED");
    }
    if (this._disposed) {
      throw new OctomilError("Model has been disposed", "SESSION_DISPOSED");
    }

    // Attempt cloud routing if configured.
    if (this._routingClient && this._deviceCaps) {
      const cloudResult = await this.tryCloudInference(input);
      if (cloudResult) return cloudResult;
    }

    // Local inference (default path).
    const start = performance.now();
    const output = await this.engine.run(this.session!, input);
    const latencyMs = performance.now() - start;
    this.telemetry?.track("inference", {
      "model.id": this.modelRef,
      "inference.duration_ms": latencyMs,
      "inference.modality": "tensor",
      "inference.target": "device",
    });
    return { ...output, latencyMs };
  }

  async predictBatch(inputs: PredictInput[]): Promise<PredictOutput[]> {
    const results: PredictOutput[] = [];
    for (const input of inputs) {
      results.push(await this.predict(input));
    }
    return results;
  }

  dispose(): void {
    this.session = null;
    this._disposed = true;
    this._inputNames = [];
    this._outputNames = [];
  }

  private async tryCloudInference(input: PredictInput): Promise<PredictOutput | null> {
    try {
      const decision = await this._routingClient!.route(
        this.modelRef,
        this._modelParams,
        this._modelSizeMb,
        this._deviceCaps!,
      );

      if (!decision || decision.target !== "cloud") {
        return null;
      }

      const start = performance.now();
      const cloudResponse = await this._routingClient!.cloudInfer(
        this.modelRef,
        input,
      );
      const latencyMs = performance.now() - start;

      this.telemetry?.track("inference", {
        "model.id": this.modelRef,
        "inference.duration_ms": latencyMs,
        "inference.target": "cloud",
        "inference.provider": cloudResponse.provider,
        "routing.id": decision.id,
      });

      return {
        tensors: {},
        latencyMs,
        ...(typeof cloudResponse.output === "object" && cloudResponse.output !== null
          ? (cloudResponse.output as Record<string, unknown>)
          : { label: String(cloudResponse.output) }),
      };
    } catch {
      // Any failure → fall back to local inference silently.
      return null;
    }
  }
}
