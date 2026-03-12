import type { ModelRuntime } from "../../core/model-runtime.js";
import type { LoadOptions, PredictInput, PredictOutput, NamedTensors, TensorData } from "../../../types.js";
import { OctomilError } from "../../../types.js";

export interface SessionResult {
  session: unknown;
  inputNames: string[];
  outputNames: string[];
  activeProvider: string;
}

// Provider fallback chains
const PROVIDER_MAP: Record<string, string[]> = {
  cpu: ["cpu"],
  cuda: ["cuda", "cpu"],
  tensorrt: ["tensorrt", "cuda", "cpu"],
  coreml: ["coreml", "cpu"],
};

// We use `any` for onnxruntime-node interop because the library's
// type exports (InferenceSession as a factory, Tensor constructor overloads)
// don't map cleanly to InstanceType<> or literal string unions. Keeping
// the public API fully typed while casting at the boundary is the pragmatic choice.

export class InferenceEngine implements ModelRuntime {
  private _session: unknown = null;
  private _disposed = false;
  async createSession(filePath: string, options?: LoadOptions): Promise<SessionResult> {
    let ort: any;
    try {
      ort = await import("onnxruntime-node");
    } catch {
      throw new OctomilError(
        "onnxruntime-node is not installed. Run: pnpm add onnxruntime-node",
        "MODEL_LOAD_FAILED",
      );
    }

    const sessionOptions: Record<string, unknown> = {
      graphOptimizationLevel: options?.graphOptimizationLevel ?? "all",
    };

    if (options?.interOpNumThreads !== undefined) {
      sessionOptions.interOpNumThreads = options.interOpNumThreads;
    }
    if (options?.intraOpNumThreads !== undefined) {
      sessionOptions.intraOpNumThreads = options.intraOpNumThreads;
    }

    const providerName = options?.executionProvider ?? "cpu";
    const providers = PROVIDER_MAP[providerName] ?? ["cpu"];
    sessionOptions.executionProviders = providers;

    let session: any;
    let activeProvider = providerName;

    try {
      session = await ort.InferenceSession.create(filePath, sessionOptions);
    } catch (err) {
      // Fallback to CPU if requested provider fails
      if (providerName !== "cpu") {
        sessionOptions.executionProviders = ["cpu"];
        activeProvider = "cpu";
        try {
          session = await ort.InferenceSession.create(filePath, sessionOptions);
        } catch (fallbackErr) {
          throw new OctomilError(
            `Failed to load model: ${String(fallbackErr)}`,
            "MODEL_LOAD_FAILED",
            fallbackErr,
          );
        }
      } else {
        throw new OctomilError(
          `Failed to load model: ${String(err)}`,
          "MODEL_LOAD_FAILED",
          err,
        );
      }
    }

    const inputNames: string[] = session.inputNames ?? [];
    const outputNames: string[] = session.outputNames ?? [];

    this._session = session;

    return { session, inputNames, outputNames, activeProvider };
  }

  async run(session: unknown, input: PredictInput): Promise<Omit<PredictOutput, "latencyMs">> {
    let ort: any;
    try {
      ort = await import("onnxruntime-node");
    } catch {
      throw new OctomilError("onnxruntime-node is not installed", "INFERENCE_FAILED");
    }

    const ortSession = session as any;
    const feeds: Record<string, any> = {};

    if ("text" in input) {
      // Text input: encode as Int32Array
      const textInput = input as { text: string };
      const encoded = new Int32Array(
        Array.from(textInput.text).map((c) => c.charCodeAt(0)),
      );
      const inputName: string = ortSession.inputNames?.[0] ?? "input";
      feeds[inputName] = new ort.Tensor("int32", encoded, [1, encoded.length]);
    } else if ("raw" in input) {
      const rawInput = input as { raw: TensorData; dims: number[] };
      const inputName: string = ortSession.inputNames?.[0] ?? "input";
      const tensorType = inferTensorType(rawInput.raw);
      feeds[inputName] = new ort.Tensor(tensorType, rawInput.raw, rawInput.dims);
    } else {
      // NamedTensors
      const namedInput = input as NamedTensors;
      for (const name of Object.keys(namedInput)) {
        const tensor = namedInput[name]!;
        const tensorType = inferTensorType(tensor.data);
        feeds[name] = new ort.Tensor(tensorType, tensor.data, tensor.dims);
      }
    }

    let results: Record<string, { data: TensorData; dims: readonly number[] }>;
    try {
      const raw: Record<string, any> = await ortSession.run(feeds);
      results = {};
      for (const [key, value] of Object.entries(raw)) {
        results[key] = {
          data: value.data as TensorData,
          dims: [...(value.dims ?? [])],
        };
      }
    } catch (err) {
      throw new OctomilError(
        `Inference failed: ${String(err)}`,
        "INFERENCE_FAILED",
        err,
      );
    }

    // Build output
    const tensors: NamedTensors = {};
    for (const [key, value] of Object.entries(results)) {
      tensors[key] = { data: value.data, dims: [...value.dims] };
    }

    // Extract convenience fields from first output
    const firstKey = Object.keys(tensors)[0];
    const firstTensor = firstKey ? tensors[firstKey] : undefined;
    let label: string | undefined;
    let score: number | undefined;
    let scores: number[] | undefined;

    if (firstTensor && firstTensor.data instanceof Float32Array) {
      scores = Array.from(firstTensor.data);
      if (scores.length > 0) {
        const maxIdx = scores.indexOf(Math.max(...scores));
        score = scores[maxIdx];
        label = String(maxIdx);
      }
    }

    return { tensors, label, score, scores };
  }

  // ---------------------------------------------------------------------------
  // ModelRuntime interface methods
  // ---------------------------------------------------------------------------

  /**
   * ModelRuntime.run() — simplified interface for running inference.
   * Uses the session stored from the last createSession() call.
   */
  async runSimple(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this._session) {
      throw new OctomilError("No active session. Call createSession() first.", "NOT_LOADED");
    }
    if (this._disposed) {
      throw new OctomilError("Engine has been disposed.", "SESSION_DISPOSED");
    }

    const predictInput = input as unknown as PredictInput;
    const result = await this.run(this._session, predictInput);
    return result as unknown as Record<string, unknown>;
  }

  dispose(): void {
    this._session = null;
    this._disposed = true;
  }
}

function inferTensorType(data: TensorData): string {
  if (data instanceof Float32Array) return "float32";
  if (data instanceof Int32Array) return "int32";
  if (data instanceof BigInt64Array) return "int64";
  if (data instanceof Uint8Array) return "uint8";
  return "float32";
}
