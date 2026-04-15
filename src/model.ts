import type { InferenceEngine } from "./runtime/engines/onnx/engine.js";
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

  /** Optional routing client for device/cloud inference decisions. */
  private _routingClient: RoutingClient | null = null;
  private _deviceCaps: DeviceCapabilities | null = null;
  private _modelParams = 0;
  private _modelSizeMb = 0;

  /** Model version tag (e.g. "latest", "v1.2"). Set during pull. */
  public readonly version: string;
  /** Model format (e.g. "onnx", "tflite"). Set during pull. */
  public readonly format: string;

  constructor(
    public readonly modelRef: string,
    public readonly filePath: string,
    engine: InferenceEngine,
    telemetry: TelemetryReporter | null,
    version?: string,
    format?: string,
    legacyFormat?: string,
  ) {
    this.engine = engine;
    this.telemetry = telemetry;
    // Older callers passed an unused options slot before version/format:
    // new Model(ref, path, engine, telemetry, undefined, "v2", "tflite").
    // Preserve that arity so published SDK consumers do not silently lose
    // version metadata.
    this.version = legacyFormat === undefined ? (version ?? "") : (format ?? "");
    this.format = legacyFormat ?? format ?? "";
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
      throw new OctomilError("CANCELLED", "Model has been disposed");
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
      throw new OctomilError("MODEL_LOAD_FAILED", "Model not loaded. Call load() first.");
    }
    if (this._disposed) {
      throw new OctomilError("CANCELLED", "Model has been disposed");
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

  /**
   * Pre-warm the model by running a dummy inference pass.
   *
   * This triggers any lazy allocation inside the runtime (e.g. GPU memory,
   * thread pool spin-up, graph optimisation) so the first real inference
   * call doesn't pay the cold-start penalty.
   *
   * Requires the model to be loaded first.
   */
  async warmup(): Promise<void> {
    if (!this.isLoaded) {
      throw new OctomilError("MODEL_LOAD_FAILED", "Model not loaded. Call load() first.");
    }
    if (this._disposed) {
      throw new OctomilError("CANCELLED", "Model has been disposed");
    }

    // Build a minimal dummy input using the session's declared input names.
    // We use a small 1-element float tensor for each input.
    const dummyInput: Record<string, { data: Float32Array; dims: number[] }> = {};
    for (const name of this._inputNames) {
      dummyInput[name] = { data: new Float32Array([0]), dims: [1] };
    }

    try {
      await this.engine.run(this.session!, dummyInput as PredictInput);
    } catch {
      // Warmup failures are non-fatal — some models may reject dummy shapes.
      // The purpose is to trigger runtime-level allocation, not to produce
      // meaningful output.
    }

    this.telemetry?.track("model_warmup", {
      "model.id": this.modelRef,
    });
  }

  /**
   * Stream inference results from the model.
   *
   * For standard ONNX runtimes this yields a single `PredictOutput` since
   * ONNX Runtime does not natively support token-level streaming. Custom
   * `ModelRuntime` implementations may yield multiple partial results.
   *
   * Callers should consume via `for await`:
   * ```ts
   * for await (const output of model.predictStream(input)) { ... }
   * ```
   */
  async *predictStream(input: PredictInput): AsyncGenerator<PredictOutput> {
    yield await this.predict(input);
  }

  async predictBatch(inputs: PredictInput[]): Promise<PredictOutput[]> {
    const results: PredictOutput[] = [];
    for (const input of inputs) {
      results.push(await this.predict(input));
    }
    return results;
  }

  /**
   * Close the model, releasing the underlying session and buffers.
   *
   * This is the canonical shutdown method. `dispose()` is kept as an alias
   * for backward compatibility.
   */
  close(): void {
    this.session = null;
    this._disposed = true;
    this._inputNames = [];
    this._outputNames = [];
  }

  /** @deprecated Use `close()` instead. */
  dispose(): void {
    this.close();
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
