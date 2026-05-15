import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import koffi, { type IKoffiLib } from "koffi";
import { RuntimeCapability } from "../../_generated/runtime_capability.js";
import { OctomilError, type OctomilErrorCode } from "../../types.js";

export const ENV_RUNTIME_DYLIB = "OCTOMIL_RUNTIME_DYLIB";
export const ENV_RUNTIME_CACHE_DIR = "OCTOMIL_RUNTIME_CACHE_DIR";
export const ENV_RUNTIME_FLAVOR = "OCTOMIL_RUNTIME_FLAVOR";

/**
 * Flavor preference order for default selection.
 * When multiple flavors are cached for the same version, the first flavor in
 * this list wins. Chat is first because it covers chat-completion and
 * embeddings — the common consumer paths. STT is opt-in via
 * OCTOMIL_RUNTIME_FLAVOR=stt.
 */
export const FLAVOR_PREFERENCE: readonly string[] = ["chat", "stt"] as const;
// IMPORTANT: REQUIRED_ABI.minor stays at 10 even after the ABI-11 image
// bindings land. The image-input symbols (oct_session_send_image,
// oct_image_view_size, oct_image_view_t, OCT_IMAGE_MIME_*,
// OCT_EMBED_POOLING_IMAGE_CLIP) are resolved OPTIONALLY when the loaded
// runtime advertises minor >= 11. The hard required minor is only flipped
// to 11 once a public SDK surface actually requires image-send support.
// Per octomil-runtime #86 (1d92e35) and embeddings-image-abi-scope.md §8.
export const REQUIRED_ABI = { major: 0, minor: 10, patch: 0 } as const;
// ABI minor at which the optional image-input bindings appear.
export const OPTIONAL_ABI_MINOR_IMAGE = 11 as const;
export const OCT_CACHE_SCOPE_REQUEST: NativeCacheScope = 0;
export const OCT_CACHE_SCOPE_SESSION: NativeCacheScope = 1;
export const OCT_CACHE_SCOPE_RUNTIME: NativeCacheScope = 2;
export const OCT_CACHE_SCOPE_APP: NativeCacheScope = 3;

// ── Event type constants (mirrors octomil-runtime ABI + Python loader.py) ──
export const OCT_EVENT_NONE = 0;
export const OCT_EVENT_SESSION_STARTED = 1;
export const OCT_EVENT_AUDIO_CHUNK = 2;
export const OCT_EVENT_TRANSCRIPT_CHUNK = 3;
export const OCT_EVENT_ERROR = 7;
export const OCT_EVENT_SESSION_COMPLETED = 8;
export const OCT_EVENT_METRIC = 19;
export const OCT_EVENT_EMBEDDING_VECTOR = 20;
export const OCT_EVENT_TRANSCRIPT_SEGMENT = 21;
export const OCT_EVENT_TRANSCRIPT_FINAL = 22;
export const OCT_EVENT_TTS_AUDIO_CHUNK = 23;
export const OCT_EVENT_VAD_TRANSITION = 24;
export const OCT_EVENT_DIARIZATION_SEGMENT = 25;

// ── VAD transition kind constants ─────────────────────────────────────────
export const OCT_VAD_TRANSITION_UNKNOWN = 0;
export const OCT_VAD_TRANSITION_SPEECH_START = 1;
export const OCT_VAD_TRANSITION_SPEECH_END = 2;

// ── Sample format constants ────────────────────────────────────────────────
export const OCT_SAMPLE_FORMAT_PCM_S16LE = 1;
export const OCT_SAMPLE_FORMAT_PCM_F32LE = 2;

// ── Diarization speaker sentinel ──────────────────────────────────────────
export const OCT_DIARIZATION_SPEAKER_UNKNOWN = 65535;

// ── v0.1.12 (ABI minor 11) — image input MIME discriminator ───────────────
// Closed enum with a forward-compat sentinel at 0. Mirrors
// OCT_VAD_TRANSITION_UNKNOWN / OCT_SAMPLE_FORMAT_UNKNOWN: bindings that see
// an unknown value MUST treat it as OCT_IMAGE_MIME_UNKNOWN and surface
// INVALID_INPUT rather than crash.
export const OCT_IMAGE_MIME_UNKNOWN = 0;
export const OCT_IMAGE_MIME_PNG = 1;
export const OCT_IMAGE_MIME_JPEG = 2;
export const OCT_IMAGE_MIME_WEBP = 3;
export const OCT_IMAGE_MIME_RGB8 = 4;

// ── v0.1.12 (ABI minor 11) — image embedding pooling discriminator ────────
// Appended to the embedding pooling-type enum; existing values
// (OCT_EMBED_POOLING_MEAN=1, _CLS=2, _LAST=3, _RANK=4) are unchanged.
// Disambiguates image vs text embeddings at the consumer side.
export const OCT_EMBED_POOLING_IMAGE_CLIP = 5;

const RUNTIME_CONFIG_VERSION = 1;
const CAPABILITIES_VERSION = 1;
const CACHE_SENTINEL = ".extracted-ok";
const CACHE_LIB_NAMES = [
  "liboctomil-runtime.dylib",
  "liboctomil-runtime.so",
  "octomil-runtime.dll",
] as const;

export const OCT_STATUS_OK = 0;
export const OCT_STATUS_INVALID_INPUT = 1;
export const OCT_STATUS_UNSUPPORTED = 2;
export const OCT_STATUS_NOT_FOUND = 3;
export const OCT_STATUS_BUSY = 4;
export const OCT_STATUS_TIMEOUT = 5;
export const OCT_STATUS_CANCELLED = 6;
export const OCT_STATUS_INTERNAL = 7;
export const OCT_STATUS_VERSION_MISMATCH = 8;

const STATUS_NAMES: Record<number, string> = {
  [OCT_STATUS_OK]: "OCT_STATUS_OK",
  [OCT_STATUS_INVALID_INPUT]: "OCT_STATUS_INVALID_INPUT",
  [OCT_STATUS_UNSUPPORTED]: "OCT_STATUS_UNSUPPORTED",
  [OCT_STATUS_NOT_FOUND]: "OCT_STATUS_NOT_FOUND",
  [OCT_STATUS_BUSY]: "OCT_STATUS_BUSY",
  [OCT_STATUS_TIMEOUT]: "OCT_STATUS_TIMEOUT",
  [OCT_STATUS_CANCELLED]: "OCT_STATUS_CANCELLED",
  [OCT_STATUS_INTERNAL]: "OCT_STATUS_INTERNAL",
  [OCT_STATUS_VERSION_MISMATCH]: "OCT_STATUS_VERSION_MISMATCH",
};

const CONTRACTED_CAPABILITIES = new Set<string>(
  Object.values(RuntimeCapability),
);

export interface NativeRuntimeAbiVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface NativeRuntimeDiscovery {
  available: boolean;
  libraryPath?: string;
  abi?: NativeRuntimeAbiVersion;
  unsupportedCode?: "RUNTIME_UNAVAILABLE";
  unsupportedReason?: string;
}

export interface NativeRuntimeCapabilities {
  supportedEngines: string[];
  supportedCapabilities: RuntimeCapability[];
  unknownCapabilities: string[];
  supportedArchs: string[];
  ramTotalBytes: number;
  ramAvailableBytes: number;
  hasAppleSilicon: boolean;
  hasCuda: boolean;
  hasMetal: boolean;
}

export interface NativeRuntimeOpenOptions {
  artifactRoot?: string;
  maxSessions?: number;
  libraryPath?: string;
}

export interface NativeModelOpenOptions {
  modelUri: string;
  artifactDigest?: string;
  engineHint?: string;
  policyPreset?: string;
  acceleratorPref?: number;
  ramBudgetBytes?: number;
}

export interface NativeSessionOpenOptions {
  capability: RuntimeCapability | string;
  model?: NativeModel | null;
  modelUri?: string;
  locality?: string;
  policyPreset?: string;
  speakerId?: string;
  sampleRateIn?: number;
  sampleRateOut?: number;
  priority?: number;
  requestId?: string;
  routeId?: string;
  traceId?: string;
  kvPrefixKey?: string;
}

export interface NativeAudioView {
  samples: Float32Array;
  nFrames: number;
  sampleRate: number;
  channels: number;
}

/**
 * Caller-owned view over an encoded (PNG/JPEG/WEBP) or raw (RGB8) image.
 *
 * Borrowed for the duration of the oct_session_send_image call; the runtime
 * copies internally if it needs to retain. Mirrors oct_image_view_t from
 * octomil-runtime ABI minor 11 (header runtime.h, PR #86 / 1d92e35).
 *
 * - bytes:   encoded image bytes (PNG/JPEG/WEBP) or raw RGB8 pixel buffer.
 * - mime:    OCT_IMAGE_MIME_* closed enum. UNKNOWN/unrecognized values
 *            reject with INVALID_INPUT.
 *
 * NOTE: this view is the public type; the corresponding native struct is
 * registered lazily by createBindings() only when the loaded runtime
 * advertises ABI minor >= OPTIONAL_ABI_MINOR_IMAGE.
 */
export interface NativeImageView {
  bytes: Uint8Array;
  mime: number;
}

export type NativeCacheScope = 0 | 1 | 2 | 3;

export interface NativeCacheEntrySnapshot {
  capability: string;
  scope: "request" | "session" | "runtime" | "app";
  entries: number;
  bytes: number;
  hit: number;
  miss: number;
}

export interface NativeCacheSnapshot {
  version: number;
  isStub: boolean;
  entries: NativeCacheEntrySnapshot[];
}

interface NativeRuntimeConfig {
  version: number;
  artifact_root: string | null;
  telemetry_sink: null;
  telemetry_user_data: null;
  max_sessions: number;
}

interface NativeCapabilitiesStruct {
  version: number;
  size: number;
  supported_engines: unknown;
  supported_capabilities: unknown;
  supported_archs: unknown;
  ram_total_bytes: number | bigint;
  ram_available_bytes: number | bigint;
  has_apple_silicon: number;
  has_cuda: number;
  has_metal: number;
  _reserved0: number;
}

interface NativeModelConfig {
  version: number;
  model_uri: string | null;
  artifact_digest: string | null;
  engine_hint: string | null;
  policy_preset: string | null;
  accelerator_pref: number;
  ram_budget_bytes: number;
  user_data: null;
}

interface NativeSessionConfig {
  version: number;
  model_uri: string | null;
  capability: string | null;
  locality: string | null;
  policy_preset: string | null;
  speaker_id: string | null;
  sample_rate_in: number;
  sample_rate_out: number;
  priority: number;
  user_data: null;
  request_id: string | null;
  route_id: string | null;
  trace_id: string | null;
  kv_prefix_key: string | null;
  model: unknown;
}

interface NativeAudioViewStruct {
  samples: unknown;
  n_frames: number;
  sample_rate: number;
  channels: number;
  _reserved0: number;
}

// v0.1.12 (ABI minor 11) — mirrors oct_image_view_t in runtime.h.
// {const uint8_t* bytes; size_t n_bytes; uint32_t mime; uint32_t _reserved0;}
interface NativeImageViewStruct {
  bytes: unknown;
  n_bytes: number | bigint;
  mime: number;
  _reserved0: number;
}

type NativeEventStruct = ReturnType<typeof koffi.struct>;

interface NativeEventEnvelope {
  requestId: string;
  routeId: string;
  traceId: string;
  engineVersion: string;
  adapterVersion: string;
  accelerator: string;
  artifactDigest: string;
  cacheWasHit: boolean;
}

export interface NativeTranscriptChunkEvent {
  text: string;
}

export interface NativeEmbeddingVectorEvent {
  values: number[];
  nDim: number;
  nInputTokens: number;
  index: number;
  poolingType: number;
  isNormalized: boolean;
}

export interface NativeAudioChunkEvent {
  pcm: Uint8Array;
  sampleRate: number;
  sampleFormat: number;
  channels: number;
  isFinal: boolean;
}

export interface NativeTranscriptSegmentEvent {
  text: string;
  startMs: number;
  endMs: number;
  segmentIndex: number;
  isFinal: boolean;
}

export interface NativeTranscriptFinalEvent {
  text: string;
  nSegments: number;
  durationMs: number;
}

export interface NativeVadTransitionEvent {
  transitionKind: number;
  timestampMs: number;
  confidence: number;
}

export interface NativeDiarizationSegmentEvent {
  startMs: number;
  endMs: number;
  speakerId: number;
  speakerLabel: string;
}

export interface NativeTtsAudioChunkEvent {
  pcm: Uint8Array;
  sampleRate: number;
  sampleFormat: number;
  channels: number;
  isFinal: boolean;
}

export interface NativeSessionCompletedEvent {
  setupMs: number;
  engineFirstChunkMs: number;
  e2eFirstChunkMs: number;
  totalLatencyMs: number;
  queuedMs: number;
  observedChunks: number;
  capabilityVerified: boolean;
  terminalStatus: number;
}

export interface NativeErrorEvent {
  code: string;
  message: string;
  errorCode: number;
}

export interface NativeEvent extends NativeEventEnvelope {
  type: number;
  version: number;
  monotonicNs: bigint;
  userData: unknown;
  transcriptChunk?: NativeTranscriptChunkEvent;
  embeddingVector?: NativeEmbeddingVectorEvent;
  audioChunk?: NativeAudioChunkEvent;
  transcriptSegment?: NativeTranscriptSegmentEvent;
  transcriptFinal?: NativeTranscriptFinalEvent;
  vadTransition?: NativeVadTransitionEvent;
  diarizationSegment?: NativeDiarizationSegmentEvent;
  ttsAudioChunk?: NativeTtsAudioChunkEvent;
  sessionCompleted?: NativeSessionCompletedEvent;
  error?: NativeErrorEvent;
}

interface NativeBindings {
  libraryPath: string;
  lib: IKoffiLib;
  runtimeConfigType: ReturnType<typeof koffi.struct>;
  capabilitiesType: ReturnType<typeof koffi.struct>;
  modelConfigType: ReturnType<typeof koffi.struct>;
  sessionConfigType: ReturnType<typeof koffi.struct>;
  audioViewType: ReturnType<typeof koffi.struct>;
  eventType: ReturnType<typeof koffi.struct>;
  runtimePtrType: ReturnType<typeof koffi.pointer>;
  modelPtrType: ReturnType<typeof koffi.pointer>;
  sessionPtrType: ReturnType<typeof koffi.pointer>;
  octRuntimeOpen: (config: NativeRuntimeConfig, out: [unknown]) => number;
  octRuntimeClose: (runtime: unknown) => void;
  octRuntimeCapabilities: (
    runtime: unknown,
    out: NativeCapabilitiesStruct,
  ) => number;
  octRuntimeCapabilitiesFree: (caps: NativeCapabilitiesStruct) => void;
  octRuntimeCacheClearAll: (runtime: unknown) => number;
  octRuntimeCacheClearCapability: (
    runtime: unknown,
    capability: string | null,
  ) => number;
  octRuntimeCacheClearScope: (
    runtime: unknown,
    scope: number,
  ) => number;
  octRuntimeCacheIntrospect: (
    runtime: unknown,
    buffer: Buffer,
    buflen: number,
  ) => number;
  octModelOpen: (
    runtime: unknown,
    config: NativeModelConfig,
    out: [unknown],
  ) => number;
  octModelWarm: (model: unknown) => number;
  octModelClose: (model: unknown) => number;
  octSessionOpen: (
    runtime: unknown,
    config: NativeSessionConfig,
    out: [unknown],
  ) => number;
  octSessionSendAudio: (
    session: unknown,
    audio: NativeAudioViewStruct,
  ) => number;
  octSessionSendText: (session: unknown, utf8: string | null) => number;
  octSessionPollEvent: (
    session: unknown,
    out: NativeEventStruct,
    timeoutMs: number,
  ) => number;
  octSessionCancel: (session: unknown) => number;
  octSessionClose: (session: unknown) => void;
  octRuntimeAbiVersionMajor: () => number;
  octRuntimeAbiVersionMinor: () => number;
  octRuntimeAbiVersionPatch: () => number;
  octRuntimeConfigSize: () => number;
  octCapabilitiesSize: () => number;
  octModelConfigSize: () => number;
  octSessionConfigSize: () => number;
  octAudioViewSize: () => number;
  octEventSize: () => number;
  octRuntimeLastError: (
    runtime: unknown,
    buffer: Buffer,
    buflen: number,
  ) => number;
  octLastThreadError: (buffer: Buffer, buflen: number) => number;
  // ── Optional ABI-11 image bindings ───────────────────────────────────────
  // Resolved only when the loaded runtime advertises minor >= 11. Older
  // runtimes leave these as null — they MUST NOT be called without first
  // probing both the ABI minor AND the embeddings.image capability.
  imageViewType: ReturnType<typeof koffi.struct> | null;
  octImageViewSize:
    | (() => number | bigint)
    | null;
  octSessionSendImage:
    | ((session: unknown, view: NativeImageViewStruct) => number)
    | null;
}

export class NativeRuntimeError extends OctomilError {
  constructor(
    public readonly status: number | null,
    code: OctomilErrorCode,
    message: string,
    public readonly lastError = "",
    cause?: unknown,
  ) {
    super(code, lastError ? `${message}: ${lastError}` : message, cause);
    this.name = "NativeRuntimeError";
  }
}

function statusName(status: number): string {
  return STATUS_NAMES[status] ?? `OCT_STATUS_UNKNOWN(${status})`;
}

function statusToSdkCode(status: number): OctomilErrorCode {
  switch (status) {
    case OCT_STATUS_INVALID_INPUT:
      return "INVALID_INPUT";
    case OCT_STATUS_NOT_FOUND:
      return "MODEL_NOT_FOUND";
    case OCT_STATUS_TIMEOUT:
      return "REQUEST_TIMEOUT";
    case OCT_STATUS_CANCELLED:
      return "CANCELLED";
    case OCT_STATUS_UNSUPPORTED:
    case OCT_STATUS_BUSY:
    case OCT_STATUS_INTERNAL:
    case OCT_STATUS_VERSION_MISMATCH:
    default:
      return "RUNTIME_UNAVAILABLE";
  }
}

function runtimeCacheRoot(): string {
  return (
    process.env[ENV_RUNTIME_CACHE_DIR] ??
    join(homedir(), ".cache", "octomil-runtime")
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

type VersionSortKey =
  | { kind: "parsed"; nums: number[]; suffix: string }
  | { kind: "raw"; name: string };

function versionSortKey(name: string): VersionSortKey {
  const raw = name.startsWith("v") ? name.slice(1) : name;
  const [core = "", suffix = "\uffff"] = raw.split("-", 2);
  const parts = core.split(".");
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return { kind: "raw", name };
    nums.push(Number(part));
  }
  return { kind: "parsed", nums, suffix: suffix || "\uffff" };
}

function compareVersionDirs(a: string, b: string): number {
  const left = versionSortKey(a);
  const right = versionSortKey(b);
  if (left.kind !== right.kind) return left.kind === "raw" ? -1 : 1;
  if (left.kind === "raw" && right.kind === "raw")
    return left.name.localeCompare(right.name);
  if (left.kind !== "parsed" || right.kind !== "parsed") return 0;

  const leftNums = left.nums;
  const rightNums = right.nums;
  const max = Math.max(leftNums.length, rightNums.length);
  for (let i = 0; i < max; i += 1) {
    const delta = (leftNums[i] ?? 0) - (rightNums[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return left.suffix.localeCompare(right.suffix);
}

export function fetchedRuntimeLibraryCandidates(): string[] {
  const root = runtimeCacheRoot();
  if (!existsSync(root)) return [];

  // ── Env-var flavor filter ─────────────────────────────────────────────────
  // OCTOMIL_RUNTIME_FLAVOR={chat,stt}: if set, only candidates from that
  // flavor subdir are returned. Authoritative — no fallback. Throws on an
  // unrecognised value so misconfiguration is never silent.
  const flavorOverride = process.env[ENV_RUNTIME_FLAVOR];
  if (flavorOverride !== undefined && flavorOverride !== "") {
    const validFlavors = new Set(FLAVOR_PREFERENCE);
    if (!validFlavors.has(flavorOverride)) {
      throw new NativeRuntimeError(
        null,
        "RUNTIME_UNAVAILABLE",
        `${ENV_RUNTIME_FLAVOR} is set to "${flavorOverride}", which is not a recognised flavor. ` +
          `Valid values: ${[...FLAVOR_PREFERENCE].join(", ")}`,
      );
    }
  }

  const candidates: string[] = [];

  // Walk version dirs newest-first so that when we build the list the most
  // desirable candidate ends up at index 0 after the per-flavor sort below.
  const versionDirs = readdirSync(root).sort(compareVersionDirs).reverse();

  for (const versionDir of versionDirs) {
    const versionPath = join(root, versionDir);
    try {
      if (!statSync(versionPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // ── Legacy layout: <version>/lib/.extracted-ok ──────────────────────────
    // Pre-flavor cache written before v0.1.5. Treat as chat-compatible and
    // include it so existing caches keep working without a re-fetch.
    // If a flavor override is set, legacy entries are treated as "chat"
    // (no named flavor dir) and are included only when override === "chat".
    const legacyLibDir = join(versionPath, "lib");
    if (isFile(join(legacyLibDir, CACHE_SENTINEL))) {
      if (flavorOverride === undefined || flavorOverride === "" || flavorOverride === "chat") {
        for (const name of CACHE_LIB_NAMES) {
          const candidate = join(legacyLibDir, name);
          if (isFile(candidate)) candidates.push(candidate);
        }
      }
      // Legacy version dir fully consumed — don't also descend into flavors.
      continue;
    }

    // ── Flavor-keyed layout: <version>/<flavor>/lib/.extracted-ok ───────────
    // Sort flavor subdirs by FLAVOR_PREFERENCE (chat before stt; unknown last)
    // so that within a version the most-preferred flavor is pushed first and
    // ends up at a lower index in the overall candidate list.
    let flavorDirs: string[];
    try {
      flavorDirs = readdirSync(versionPath);
    } catch {
      continue;
    }

    // Apply flavor override filter before sorting.
    if (flavorOverride !== undefined && flavorOverride !== "") {
      flavorDirs = flavorDirs.filter((d) => d === flavorOverride);
    }

    flavorDirs.sort((a, b) => {
      const ai = FLAVOR_PREFERENCE.indexOf(a);
      const bi = FLAVOR_PREFERENCE.indexOf(b);
      const aRank = ai === -1 ? FLAVOR_PREFERENCE.length : ai;
      const bRank = bi === -1 ? FLAVOR_PREFERENCE.length : bi;
      return aRank - bRank;
    });

    for (const flavorDir of flavorDirs) {
      const flavorPath = join(versionPath, flavorDir);
      try {
        if (!statSync(flavorPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const libDir = join(flavorPath, "lib");
      if (!isFile(join(libDir, CACHE_SENTINEL))) continue;
      for (const name of CACHE_LIB_NAMES) {
        const candidate = join(libDir, name);
        if (isFile(candidate)) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

export function resolveNativeRuntimeLibrary(
  options: { libraryPath?: string } = {},
): string {
  if (options.libraryPath) {
    if (isFile(options.libraryPath)) return options.libraryPath;
    throw new NativeRuntimeError(
      null,
      "RUNTIME_UNAVAILABLE",
      `Native runtime library path does not exist: ${options.libraryPath}`,
    );
  }

  const override = process.env[ENV_RUNTIME_DYLIB];
  if (override) {
    if (isFile(override)) return override;
    throw new NativeRuntimeError(
      null,
      "RUNTIME_UNAVAILABLE",
      `${ENV_RUNTIME_DYLIB} points at ${override}, but that file does not exist`,
    );
  }

  const candidates = fetchedRuntimeLibraryCandidates();
  // fetchedRuntimeLibraryCandidates() returns candidates newest-version-first,
  // chat-before-stt within a version. Index 0 is always the best match.
  const best = candidates[0];
  if (best) return best;

  throw new NativeRuntimeError(
    null,
    "RUNTIME_UNAVAILABLE",
    `Could not locate liboctomil-runtime; set ${ENV_RUNTIME_DYLIB} or populate ${runtimeCacheRoot()}`,
  );
}

function createBindings(libraryPath: string): NativeBindings {
  let lib: IKoffiLib;
  try {
    lib = koffi.load(libraryPath);
  } catch (error) {
    throw new NativeRuntimeError(
      null,
      "RUNTIME_UNAVAILABLE",
      `Failed to load native runtime library ${libraryPath}`,
      "",
      error,
    );
  }

  const runtimeType = koffi.opaque();
  const sessionType = koffi.opaque();
  const modelType = koffi.opaque();
  const runtimePtrType = koffi.pointer(runtimeType);
  const sessionPtrType = koffi.pointer(sessionType);
  const modelPtrType = koffi.pointer(modelType);

  const runtimeConfigType = koffi.struct({
    version: "uint32_t",
    artifact_root: "str",
    telemetry_sink: "void *",
    telemetry_user_data: "void *",
    max_sessions: "uint32_t",
  });
  const capabilitiesType = koffi.struct({
    version: "uint32_t",
    size: "size_t",
    supported_engines: "const char **",
    supported_capabilities: "const char **",
    supported_archs: "const char **",
    ram_total_bytes: "uint64_t",
    ram_available_bytes: "uint64_t",
    has_apple_silicon: "uint8_t",
    has_cuda: "uint8_t",
    has_metal: "uint8_t",
    _reserved0: "uint8_t",
  });
  const modelConfigType = koffi.struct({
    version: "uint32_t",
    model_uri: "str",
    artifact_digest: "str",
    engine_hint: "str",
    policy_preset: "str",
    accelerator_pref: "uint32_t",
    ram_budget_bytes: "uint64_t",
    user_data: "void *",
  });
  const sessionConfigType = koffi.struct({
    version: "uint32_t",
    model_uri: "str",
    capability: "str",
    locality: "str",
    policy_preset: "str",
    speaker_id: "str",
    sample_rate_in: "uint32_t",
    sample_rate_out: "uint32_t",
    priority: "uint32_t",
    user_data: "void *",
    request_id: "str",
    route_id: "str",
    trace_id: "str",
    kv_prefix_key: "str",
    model: modelPtrType,
  });
  const audioViewType = koffi.struct({
    samples: "float *",
    n_frames: "uint32_t",
    sample_rate: "uint32_t",
    channels: "uint16_t",
    _reserved0: "uint16_t",
  });

  const audioChunkType = koffi.struct({
    pcm: "uint8_t *",
    n_bytes: "uint32_t",
    sample_rate: "uint32_t",
    sample_format: "uint32_t",
    channels: "uint16_t",
    is_final: "uint8_t",
    _reserved0: "uint8_t",
  });
  const transcriptChunkType = koffi.struct({
    utf8: "str",
    n_bytes: "uint32_t",
  });
  const errorType = koffi.struct({
    code: "str",
    message: "str",
    error_code: "uint32_t",
    _reserved0: "uint32_t",
  });
  const sessionStartedType = koffi.struct({
    engine: "str",
    model_digest: "str",
    locality: "str",
    streaming_mode: "str",
    runtime_build_tag: "str",
  });
  const sessionCompletedType = koffi.struct({
    setup_ms: "float",
    engine_first_chunk_ms: "float",
    e2e_first_chunk_ms: "float",
    total_latency_ms: "float",
    queued_ms: "float",
    observed_chunks: "uint32_t",
    capability_verified: "uint8_t",
    _reserved0: "uint8_t",
    _reserved1: "uint16_t",
    terminal_status: "uint32_t",
  });
  const inputDroppedType = koffi.struct({
    n_frames_dropped: "uint32_t",
    sample_rate: "uint32_t",
    channels: "uint16_t",
    _reserved0: "uint16_t",
    reason: "str",
    dropped_at_ns: "uint64_t",
  });
  const modelLoadedType = koffi.struct({
    engine: "str",
    model_id: "str",
    artifact_digest: "str",
    load_ms: "uint64_t",
    warm_ms: "uint64_t",
    policy_preset: "str",
    config_user_data: "void *",
    source: "str",
  });
  const modelEvictedType = koffi.struct({
    engine: "str",
    model_id: "str",
    artifact_digest: "str",
    freed_bytes: "uint64_t",
    reason: "str",
    config_user_data: "void *",
  });
  const cacheType = koffi.struct({
    layer: "str",
    saved_tokens: "uint32_t",
    _reserved0: "uint32_t",
  });
  const queuedType = koffi.struct({
    queue_position: "uint32_t",
    queue_depth: "uint32_t",
  });
  const preemptedType = koffi.struct({
    preempted_by_priority: "uint32_t",
    _reserved0: "uint32_t",
    reason: "str",
  });
  const memoryPressureType = koffi.struct({
    ram_available_bytes: "uint64_t",
    severity: "uint8_t",
    _reserved0: "uint8_t",
    _reserved1: "uint16_t",
    _reserved2: "uint32_t",
  });
  const thermalStateType = koffi.struct({
    state: "uint8_t",
    _reserved0: "uint8_t",
    _reserved1: "uint16_t",
    _reserved2: "uint32_t",
  });
  const watchdogTimeoutType = koffi.struct({
    timeout_ms: "uint32_t",
    _reserved0: "uint32_t",
    phase: "str",
  });
  const metricType = koffi.struct({
    name: "str",
    value: "double",
  });
  const embeddingVectorType = koffi.struct({
    values: "float *",
    n_dim: "uint32_t",
    n_input_tokens: "uint32_t",
    index: "uint32_t",
    pooling_type: "uint32_t",
    is_normalized: "uint8_t",
    _reserved0: "uint8_t",
    _reserved1: "uint16_t",
  });
  const vadTransitionType = koffi.struct({
    transition_kind: "uint32_t",
    timestamp_ms: "uint32_t",
    confidence: "float",
    _reserved0: "uint32_t",
  });
  const transcriptSegmentType = koffi.struct({
    utf8: "str",
    n_bytes: "uint32_t",
    start_ms: "uint32_t",
    end_ms: "uint32_t",
    segment_index: "uint32_t",
    is_final: "uint8_t",
    _reserved0: "uint8_t",
    _reserved1: "uint16_t",
  });
  const transcriptFinalType = koffi.struct({
    utf8: "str",
    n_bytes: "uint32_t",
    n_segments: "uint32_t",
    duration_ms: "uint32_t",
    _reserved0: "uint32_t",
    _reserved1: "uint32_t",
  });
  const diarizationSegmentType = koffi.struct({
    start_ms: "uint32_t",
    end_ms: "uint32_t",
    speaker_id: "uint16_t",
    _reserved0: "uint16_t",
    _reserved1: "uint32_t",
    speaker_label: "str",
  });
  const ttsAudioChunkType = koffi.struct({
    pcm: "uint8_t *",
    n_bytes: "uint32_t",
    sample_rate: "uint32_t",
    sample_format: "uint32_t",
    channels: "uint16_t",
    is_final: "uint8_t",
    _reserved0: "uint8_t",
  });

  const eventDataType = koffi.union({
    audio_chunk: audioChunkType,
    transcript_chunk: transcriptChunkType,
    error: errorType,
    session_started: sessionStartedType,
    session_completed: sessionCompletedType,
    input_dropped: inputDroppedType,
    model_loaded: modelLoadedType,
    model_evicted: modelEvictedType,
    cache: cacheType,
    queued: queuedType,
    preempted: preemptedType,
    memory_pressure: memoryPressureType,
    thermal_state: thermalStateType,
    watchdog_timeout: watchdogTimeoutType,
    metric: metricType,
    embedding_vector: embeddingVectorType,
    vad_transition: vadTransitionType,
    transcript_segment: transcriptSegmentType,
    transcript_final: transcriptFinalType,
    diarization_segment: diarizationSegmentType,
    tts_audio_chunk: ttsAudioChunkType,
  });
  const eventType = koffi.struct({
    version: "uint32_t",
    size: "size_t",
    type: "uint32_t",
    monotonic_ns: "uint64_t",
    user_data: "void *",
    data: eventDataType,
    request_id: "str",
    route_id: "str",
    trace_id: "str",
    engine_version: "str",
    adapter_version: "str",
    accelerator: "str",
    artifact_digest: "str",
    cache_was_hit: "uint8_t",
    _reserved0: "uint8_t",
    _reserved1: "uint16_t",
    _reserved2: "uint32_t",
  });

  try {
    const bindings: NativeBindings = {
      libraryPath,
      lib,
      runtimeConfigType,
      capabilitiesType,
      modelConfigType,
      sessionConfigType,
      audioViewType,
      eventType,
      runtimePtrType,
      modelPtrType,
      sessionPtrType,
      octRuntimeOpen: lib.func("oct_runtime_open", "uint32_t", [
        koffi.pointer(runtimeConfigType),
        koffi.out(koffi.pointer(runtimePtrType)),
      ]) as NativeBindings["octRuntimeOpen"],
      octRuntimeClose: lib.func("oct_runtime_close", "void", [
        runtimePtrType,
      ]) as NativeBindings["octRuntimeClose"],
      octRuntimeCapabilities: lib.func("oct_runtime_capabilities", "uint32_t", [
        runtimePtrType,
        koffi.inout(koffi.pointer(capabilitiesType)),
      ]) as NativeBindings["octRuntimeCapabilities"],
      octRuntimeCapabilitiesFree: lib.func(
        "oct_runtime_capabilities_free",
        "void",
        [koffi.inout(koffi.pointer(capabilitiesType))],
      ) as NativeBindings["octRuntimeCapabilitiesFree"],
      octRuntimeCacheClearAll: lib.func(
        "oct_runtime_cache_clear_all",
        "uint32_t",
        [runtimePtrType],
      ) as NativeBindings["octRuntimeCacheClearAll"],
      octRuntimeCacheClearCapability: lib.func(
        "oct_runtime_cache_clear_capability",
        "uint32_t",
        [runtimePtrType, "str"],
      ) as NativeBindings["octRuntimeCacheClearCapability"],
      octRuntimeCacheClearScope: lib.func(
        "oct_runtime_cache_clear_scope",
        "uint32_t",
        [runtimePtrType, "uint32_t"],
      ) as NativeBindings["octRuntimeCacheClearScope"],
      octRuntimeCacheIntrospect: lib.func(
        "oct_runtime_cache_introspect",
        "uint32_t",
        [runtimePtrType, "char *", "size_t"],
      ) as NativeBindings["octRuntimeCacheIntrospect"],
      octModelOpen: lib.func("oct_model_open", "uint32_t", [
        runtimePtrType,
        koffi.pointer(modelConfigType),
        koffi.out(koffi.pointer(modelPtrType)),
      ]) as NativeBindings["octModelOpen"],
      octModelWarm: lib.func("oct_model_warm", "uint32_t", [
        modelPtrType,
      ]) as NativeBindings["octModelWarm"],
      octModelClose: lib.func("oct_model_close", "uint32_t", [
        modelPtrType,
      ]) as NativeBindings["octModelClose"],
      octSessionOpen: lib.func("oct_session_open", "uint32_t", [
        runtimePtrType,
        koffi.pointer(sessionConfigType),
        koffi.out(koffi.pointer(sessionPtrType)),
      ]) as NativeBindings["octSessionOpen"],
      octSessionSendAudio: lib.func("oct_session_send_audio", "uint32_t", [
        sessionPtrType,
        koffi.pointer(audioViewType),
      ]) as NativeBindings["octSessionSendAudio"],
      octSessionSendText: lib.func("oct_session_send_text", "uint32_t", [
        sessionPtrType,
        "str",
      ]) as NativeBindings["octSessionSendText"],
      octSessionPollEvent: lib.func("oct_session_poll_event", "uint32_t", [
        sessionPtrType,
        koffi.inout(koffi.pointer(eventType)),
        "uint32_t",
      ]) as NativeBindings["octSessionPollEvent"],
      octSessionCancel: lib.func("oct_session_cancel", "uint32_t", [
        sessionPtrType,
      ]) as NativeBindings["octSessionCancel"],
      octSessionClose: lib.func("oct_session_close", "void", [
        sessionPtrType,
      ]) as NativeBindings["octSessionClose"],
      octRuntimeAbiVersionMajor: lib.func(
        "oct_runtime_abi_version_major",
        "uint32_t",
        [],
      ) as NativeBindings["octRuntimeAbiVersionMajor"],
      octRuntimeAbiVersionMinor: lib.func(
        "oct_runtime_abi_version_minor",
        "uint32_t",
        [],
      ) as NativeBindings["octRuntimeAbiVersionMinor"],
      octRuntimeAbiVersionPatch: lib.func(
        "oct_runtime_abi_version_patch",
        "uint32_t",
        [],
      ) as NativeBindings["octRuntimeAbiVersionPatch"],
      octRuntimeConfigSize: lib.func(
        "oct_runtime_config_size",
        "size_t",
        [],
      ) as NativeBindings["octRuntimeConfigSize"],
      octCapabilitiesSize: lib.func(
        "oct_capabilities_size",
        "size_t",
        [],
      ) as NativeBindings["octCapabilitiesSize"],
      octModelConfigSize: lib.func(
        "oct_model_config_size",
        "size_t",
        [],
      ) as NativeBindings["octModelConfigSize"],
      octSessionConfigSize: lib.func(
        "oct_session_config_size",
        "size_t",
        [],
      ) as NativeBindings["octSessionConfigSize"],
      octAudioViewSize: lib.func(
        "oct_audio_view_size",
        "size_t",
        [],
      ) as NativeBindings["octAudioViewSize"],
      octEventSize: lib.func(
        "oct_event_size",
        "size_t",
        [],
      ) as NativeBindings["octEventSize"],
      octRuntimeLastError: lib.func("oct_runtime_last_error", "int", [
        runtimePtrType,
        "char *",
        "size_t",
      ]) as NativeBindings["octRuntimeLastError"],
      octLastThreadError: lib.func("oct_last_thread_error", "int", [
        "char *",
        "size_t",
      ]) as NativeBindings["octLastThreadError"],
      // Optional ABI-11 image bindings — populated below after ABI probe.
      imageViewType: null,
      octImageViewSize: null,
      octSessionSendImage: null,
    };
    validateBindings(bindings);
    attachOptionalImageBindings(bindings, lib);
    return bindings;
  } catch (error) {
    try {
      lib.unload();
    } catch {
      // Ignore unload errors while surfacing the original binding failure.
    }
    if (error instanceof NativeRuntimeError) throw error;
    throw new NativeRuntimeError(
      null,
      "RUNTIME_UNAVAILABLE",
      `Native runtime library ${libraryPath} is missing required ABI symbols`,
      "",
      error,
    );
  }
}

function validateBindings(bindings: NativeBindings): void {
  const abi = readAbi(bindings);
  if (abi.major !== REQUIRED_ABI.major || abi.minor < REQUIRED_ABI.minor) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `liboctomil-runtime ABI ${abi.major}.${abi.minor}.${abi.patch} is incompatible with Node binding requirement ${REQUIRED_ABI.major}.${REQUIRED_ABI.minor}.${REQUIRED_ABI.patch}`,
    );
  }

  const runtimeConfigSize = Number(bindings.octRuntimeConfigSize());
  const capabilitiesSize = Number(bindings.octCapabilitiesSize());
  const modelConfigSize = Number(bindings.octModelConfigSize());
  const sessionConfigSize = Number(bindings.octSessionConfigSize());
  const audioViewSize = Number(bindings.octAudioViewSize());
  const eventSize = Number(bindings.octEventSize());
  if (runtimeConfigSize !== koffi.sizeof(bindings.runtimeConfigType)) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `oct_runtime_config_t size mismatch: binding=${koffi.sizeof(bindings.runtimeConfigType)} runtime=${runtimeConfigSize}`,
    );
  }
  if (capabilitiesSize !== koffi.sizeof(bindings.capabilitiesType)) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `oct_capabilities_t size mismatch: binding=${koffi.sizeof(bindings.capabilitiesType)} runtime=${capabilitiesSize}`,
    );
  }
  if (modelConfigSize !== koffi.sizeof(bindings.modelConfigType)) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `oct_model_config_t size mismatch: binding=${koffi.sizeof(bindings.modelConfigType)} runtime=${modelConfigSize}`,
    );
  }
  if (sessionConfigSize !== koffi.sizeof(bindings.sessionConfigType)) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `oct_session_config_t size mismatch: binding=${koffi.sizeof(bindings.sessionConfigType)} runtime=${sessionConfigSize}`,
    );
  }
  if (audioViewSize !== koffi.sizeof(bindings.audioViewType)) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `oct_audio_view_t size mismatch: binding=${koffi.sizeof(bindings.audioViewType)} runtime=${audioViewSize}`,
    );
  }
  if (eventSize !== koffi.sizeof(bindings.eventType)) {
    throw new NativeRuntimeError(
      OCT_STATUS_VERSION_MISMATCH,
      "RUNTIME_UNAVAILABLE",
      `oct_event_t size mismatch: binding=${koffi.sizeof(bindings.eventType)} runtime=${eventSize}`,
    );
  }
}

function readAbi(bindings: NativeBindings): NativeRuntimeAbiVersion {
  return {
    major: Number(bindings.octRuntimeAbiVersionMajor()),
    minor: Number(bindings.octRuntimeAbiVersionMinor()),
    patch: Number(bindings.octRuntimeAbiVersionPatch()),
  };
}

/**
 * Lazy-resolves the optional ABI-11 image-input symbols if (and only if) the
 * loaded runtime advertises minor >= OPTIONAL_ABI_MINOR_IMAGE.
 *
 * Hard contract:
 *   - REQUIRED_ABI.minor stays at 10. This function MUST NEVER throw on a
 *     minor-10 runtime; older runtimes leave the image fields as null.
 *   - When minor >= 11 but the symbol lookup unexpectedly fails (e.g. the
 *     dylib was built without the export despite reporting the version),
 *     the failure is swallowed and the fields stay null. Capability gating
 *     will still surface a clean unsupported error on the public surface.
 *   - The koffi struct is registered alongside the function bindings so its
 *     layout matches the runtime's oct_image_view_t. We do NOT size-check
 *     against oct_image_view_size here because the symbol is optional and
 *     size-mismatch on an optional binding should not fail the whole load.
 */
function attachOptionalImageBindings(
  bindings: NativeBindings,
  lib: IKoffiLib,
): void {
  const abi = readAbi(bindings);
  if (abi.major !== REQUIRED_ABI.major) return;
  if (abi.minor < OPTIONAL_ABI_MINOR_IMAGE) return;

  try {
    const imageViewType = koffi.struct({
      bytes: "uint8_t *",
      n_bytes: "size_t",
      mime: "uint32_t",
      _reserved0: "uint32_t",
    });
    const octImageViewSize = lib.func(
      "oct_image_view_size",
      "size_t",
      [],
    ) as () => number | bigint;
    const octSessionSendImage = lib.func(
      "oct_session_send_image",
      "uint32_t",
      [bindings.sessionPtrType, koffi.pointer(imageViewType)],
    ) as (session: unknown, view: NativeImageViewStruct) => number;

    bindings.imageViewType = imageViewType;
    bindings.octImageViewSize = octImageViewSize;
    bindings.octSessionSendImage = octSessionSendImage;
  } catch {
    // Symbol missing despite the runtime advertising minor >= 11. Leave the
    // optional fields null; capability gating on the public surface throws
    // a bounded RUNTIME_UNAVAILABLE/UNSUPPORTED. Never abort the load.
    bindings.imageViewType = null;
    bindings.octImageViewSize = null;
    bindings.octSessionSendImage = null;
  }
}

function decodeErrorBuffer(buffer: Buffer): string {
  const end = buffer.indexOf(0);
  return buffer.toString("utf8", 0, end >= 0 ? end : buffer.length);
}

function readThreadError(bindings: NativeBindings): string {
  const buffer = Buffer.alloc(4096);
  const n = bindings.octLastThreadError(buffer, buffer.length);
  return n > 0 ? decodeErrorBuffer(buffer) : "";
}

function readRuntimeError(bindings: NativeBindings, runtime: unknown): string {
  const buffer = Buffer.alloc(4096);
  const n = bindings.octRuntimeLastError(runtime, buffer, buffer.length);
  return n > 0 ? decodeErrorBuffer(buffer) : "";
}

function normalizeCacheScope(scope: NativeCacheScope): NativeCacheEntrySnapshot["scope"] {
  switch (scope) {
    case 0:
      return "request";
    case 1:
      return "session";
    case 2:
      return "runtime";
    case 3:
      return "app";
    default:
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        `cache scope ${scope} is not a valid OCT_CACHE_SCOPE_* constant`,
      );
  }
}

function parseNativeCacheSnapshot(rawJson: string): NativeCacheSnapshot {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch (cause) {
    throw new NativeRuntimeError(
      OCT_STATUS_INTERNAL,
      "RUNTIME_UNAVAILABLE",
      "cache introspect JSON payload is invalid",
      "",
      cause,
    );
  }
  if (!("version" in parsed) || !("is_stub" in parsed) || !("entries" in parsed)) {
    throw new NativeRuntimeError(
      OCT_STATUS_INTERNAL,
      "RUNTIME_UNAVAILABLE",
      "cache introspect JSON is missing required bounded fields",
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new NativeRuntimeError(
      OCT_STATUS_INTERNAL,
      "RUNTIME_UNAVAILABLE",
      "cache introspect JSON 'entries' must be an array",
    );
  }
  const version = Number(parsed.version);
  const isStub = Boolean(parsed.is_stub);
  const rawEntries = parsed.entries as unknown[];

  if (!Number.isFinite(version) || version < 0) {
    throw new NativeRuntimeError(
      OCT_STATUS_INTERNAL,
      "RUNTIME_UNAVAILABLE",
      "cache introspect JSON has invalid version",
    );
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        `cache introspect entry ${index} is not an object`,
      );
    }
    const obj = entry as Record<string, unknown>;
    const capability = String(obj.capability ?? "");
    const scope = String(obj.scope ?? "");
    const entriesCount = Number(obj.entries ?? NaN);
    const bytes = Number(obj.bytes ?? NaN);
    const hit = Number(obj.hit ?? NaN);
    const miss = Number(obj.miss ?? NaN);
    if (!capability || !scope) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        `cache introspect entry ${index} is missing bounded fields`,
      );
    }
    if (!Number.isFinite(entriesCount) || !Number.isFinite(bytes) || !Number.isFinite(hit) || !Number.isFinite(miss)) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        `cache introspect entry ${index} has non-numeric counters`,
      );
    }
    if (entriesCount < 0 || bytes < 0 || hit < 0 || miss < 0) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        `cache introspect entry ${index} has negative counters`,
      );
    }
    if (!["request", "session", "runtime", "app"].includes(scope)) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        `cache introspect entry ${index} has invalid scope ${scope}`,
      );
    }
    return {
      capability,
      scope: scope as NativeCacheEntrySnapshot["scope"],
      entries: entriesCount,
      bytes,
      hit,
      miss,
    };
  });

  return {
    version,
    isStub,
    entries,
  };
}

function decodeCStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    const decoded = koffi.decode(value, "const char *") as string | null;
    return decoded ?? "";
  } catch {
    return String(value);
  }
}

function decodeBytesValue(value: unknown, length: number): Uint8Array {
  if (value == null || length <= 0) return new Uint8Array();
  try {
    return new Uint8Array(koffi.view(value, length));
  } catch {
    return new Uint8Array();
  }
}

function decodeFloatArrayValue(value: unknown, length: number): number[] {
  if (Array.isArray(value)) return value.slice(0, length).map((entry) => Number(entry));
  if (value == null || length <= 0) return [];
  try {
    const viewed = koffi.view(value, length * 4);
    return Array.from(new Float32Array(viewed));
  } catch {
    try {
      const floats = koffi.decode(value, "float", length) as number[];
      return Array.isArray(floats) ? floats : [];
    } catch {
      return [];
    }
  }
}

function parseNativeEvent(rawEvent: Record<string, unknown>): NativeEvent {
  const data = (rawEvent.data as Record<string, unknown> | undefined) ?? {};
  const event: NativeEvent = {
    type: Number(rawEvent.type ?? 0),
    version: Number(rawEvent.version ?? 0),
    monotonicNs: BigInt(
      (rawEvent.monotonic_ns as bigint | number | string | undefined) ?? 0,
    ),
    userData: rawEvent.user_data,
    requestId: decodeCStringValue(rawEvent.request_id),
    routeId: decodeCStringValue(rawEvent.route_id),
    traceId: decodeCStringValue(rawEvent.trace_id),
    engineVersion: decodeCStringValue(rawEvent.engine_version),
    adapterVersion: decodeCStringValue(rawEvent.adapter_version),
    accelerator: decodeCStringValue(rawEvent.accelerator),
    artifactDigest: decodeCStringValue(rawEvent.artifact_digest),
    cacheWasHit: Boolean(rawEvent.cache_was_hit),
  };

  switch (event.type) {
    case 3: {
      const chunk = data.transcript_chunk as Record<string, unknown> | undefined;
      event.transcriptChunk = {
        text: decodeCStringValue(chunk?.utf8),
      };
      break;
    }
    case 7: {
      const err = data.error as Record<string, unknown> | undefined;
      event.error = {
        code: decodeCStringValue(err?.code),
        message: decodeCStringValue(err?.message),
        errorCode: Number(err?.error_code ?? 0),
      };
      break;
    }
    case 8: {
      const completed = data.session_completed as Record<string, unknown> | undefined;
      event.sessionCompleted = {
        setupMs: Number(completed?.setup_ms ?? 0),
        engineFirstChunkMs: Number(completed?.engine_first_chunk_ms ?? 0),
        e2eFirstChunkMs: Number(completed?.e2e_first_chunk_ms ?? 0),
        totalLatencyMs: Number(completed?.total_latency_ms ?? 0),
        queuedMs: Number(completed?.queued_ms ?? 0),
        observedChunks: Number(completed?.observed_chunks ?? 0),
        capabilityVerified: Boolean(completed?.capability_verified),
        terminalStatus: Number(completed?.terminal_status ?? 0),
      };
      break;
    }
    case 20: {
      const embedding = data.embedding_vector as
        | Record<string, unknown>
        | undefined;
      const nDim = Number(embedding?.n_dim ?? 0);
      event.embeddingVector = {
        values: decodeFloatArrayValue(embedding?.values, nDim),
        nDim,
        nInputTokens: Number(embedding?.n_input_tokens ?? 0),
        index: Number(embedding?.index ?? 0),
        poolingType: Number(embedding?.pooling_type ?? 0),
        isNormalized: Boolean(embedding?.is_normalized),
      };
      break;
    }
    case 21: {
      const segment = data.transcript_segment as Record<string, unknown> | undefined;
      event.transcriptSegment = {
        text: decodeCStringValue(segment?.utf8),
        startMs: Number(segment?.start_ms ?? 0),
        endMs: Number(segment?.end_ms ?? 0),
        segmentIndex: Number(segment?.segment_index ?? 0),
        isFinal: Boolean(segment?.is_final),
      };
      break;
    }
    case 22: {
      const final = data.transcript_final as Record<string, unknown> | undefined;
      event.transcriptFinal = {
        text: decodeCStringValue(final?.utf8),
        nSegments: Number(final?.n_segments ?? 0),
        durationMs: Number(final?.duration_ms ?? 0),
      };
      break;
    }
    case 23: {
      const tts = data.tts_audio_chunk as Record<string, unknown> | undefined;
      const nBytes = Number(tts?.n_bytes ?? 0);
      event.ttsAudioChunk = {
        pcm: decodeBytesValue(tts?.pcm, nBytes),
        sampleRate: Number(tts?.sample_rate ?? 0),
        sampleFormat: Number(tts?.sample_format ?? 0),
        channels: Number(tts?.channels ?? 0),
        isFinal: Boolean(tts?.is_final),
      };
      break;
    }
    case 24: {
      const vad = data.vad_transition as Record<string, unknown> | undefined;
      event.vadTransition = {
        transitionKind: Number(vad?.transition_kind ?? 0),
        timestampMs: Number(vad?.timestamp_ms ?? 0),
        confidence: Number(vad?.confidence ?? 0),
      };
      break;
    }
    case 25: {
      const diar = data.diarization_segment as
        | Record<string, unknown>
        | undefined;
      event.diarizationSegment = {
        startMs: Number(diar?.start_ms ?? 0),
        endMs: Number(diar?.end_ms ?? 0),
        speakerId: Number(diar?.speaker_id ?? 0),
        speakerLabel: decodeCStringValue(diar?.speaker_label),
      };
      break;
    }
    case 2: {
      const audio = data.audio_chunk as Record<string, unknown> | undefined;
      const nBytes = Number(audio?.n_bytes ?? 0);
      event.audioChunk = {
        pcm: decodeBytesValue(audio?.pcm, nBytes),
        sampleRate: Number(audio?.sample_rate ?? 0),
        sampleFormat: Number(audio?.sample_format ?? 0),
        channels: Number(audio?.channels ?? 0),
        isFinal: Boolean(audio?.is_final),
      };
      break;
    }
    default:
      break;
  }

  return event;
}

function throwStatus(
  bindings: NativeBindings,
  status: number,
  operation: string,
  runtime?: unknown,
): never {
  const lastError = runtime
    ? readRuntimeError(bindings, runtime)
    : readThreadError(bindings);
  throw new NativeRuntimeError(
    status,
    statusToSdkCode(status),
    `${operation} failed with ${statusName(status)}`,
    lastError,
  );
}

function decodeCStringArray(ptr: unknown, maxEntries = 4096): string[] {
  if (ptr == null) return [];

  const out: string[] = [];
  const pointerSize = koffi.sizeof("void *");
  for (let i = 0; i < maxEntries; i += 1) {
    const value = koffi.decode(ptr, i * pointerSize, "const char *") as
      | string
      | null;
    if (value == null) return out;
    out.push(value);
  }
  throw new NativeRuntimeError(
    OCT_STATUS_INTERNAL,
    "RUNTIME_UNAVAILABLE",
    `Native runtime returned a string list without a NULL sentinel within ${maxEntries} entries`,
  );
}

function toSafeNumber(value: number | bigint): number {
  if (typeof value === "bigint") {
    return value > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(value);
  }
  return value;
}

function parseCapabilities(
  caps: NativeCapabilitiesStruct,
): NativeRuntimeCapabilities {
  const rawCapabilities = decodeCStringArray(caps.supported_capabilities);
  const supportedCapabilities: RuntimeCapability[] = [];
  const unknownCapabilities: string[] = [];

  for (const capability of rawCapabilities) {
    if (CONTRACTED_CAPABILITIES.has(capability)) {
      supportedCapabilities.push(capability as RuntimeCapability);
    } else {
      unknownCapabilities.push(capability);
    }
  }

  return {
    supportedEngines: decodeCStringArray(caps.supported_engines),
    supportedCapabilities,
    unknownCapabilities,
    supportedArchs: decodeCStringArray(caps.supported_archs),
    ramTotalBytes: toSafeNumber(caps.ram_total_bytes),
    ramAvailableBytes: toSafeNumber(caps.ram_available_bytes),
    hasAppleSilicon: caps.has_apple_silicon !== 0,
    hasCuda: caps.has_cuda !== 0,
    hasMetal: caps.has_metal !== 0,
  };
}

export function discoverNativeRuntime(
  options: { libraryPath?: string } = {},
): NativeRuntimeDiscovery {
  try {
    const libraryPath = resolveNativeRuntimeLibrary(options);
    const bindings = createBindings(libraryPath);
    const discovery: NativeRuntimeDiscovery = {
      available: true,
      libraryPath,
      abi: readAbi(bindings),
    };
    bindings.lib.unload();
    return discovery;
  } catch (error) {
    return {
      available: false,
      unsupportedCode: "RUNTIME_UNAVAILABLE",
      unsupportedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export class NativeRuntime {
  private closed = false;
  private readonly sessions = new Set<NativeSession>();
  private readonly models = new Set<NativeModel>();

  private constructor(
    private readonly bindings: NativeBindings,
    private runtime: unknown,
  ) {}

  static discover(
    options: { libraryPath?: string } = {},
  ): NativeRuntimeDiscovery {
    return discoverNativeRuntime(options);
  }

  static open(options: NativeRuntimeOpenOptions = {}): NativeRuntime {
    const libraryPath = resolveNativeRuntimeLibrary(options);
    const bindings = createBindings(libraryPath);
    const out: [unknown] = [null];
    const status = bindings.octRuntimeOpen(
      {
        version: RUNTIME_CONFIG_VERSION,
        artifact_root: options.artifactRoot ?? null,
        telemetry_sink: null,
        telemetry_user_data: null,
        max_sessions: options.maxSessions ?? 0,
      },
      out,
    );
    if (status !== OCT_STATUS_OK) {
      const lastError = readThreadError(bindings);
      bindings.lib.unload();
      throw new NativeRuntimeError(
        status,
        statusToSdkCode(status),
        `oct_runtime_open failed with ${statusName(status)}`,
        lastError,
      );
    }
    if (out[0] == null) {
      bindings.lib.unload();
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        "oct_runtime_open returned OK with a NULL runtime handle",
      );
    }
    return new NativeRuntime(bindings, out[0]);
  }

  get libraryPath(): string {
    return this.bindings.libraryPath;
  }

  get abi(): NativeRuntimeAbiVersion {
    this.assertOpen();
    return readAbi(this.bindings);
  }

  lastError(): string {
    this.assertOpen();
    return readRuntimeError(this.bindings, this.runtime);
  }

  capabilities(): NativeRuntimeCapabilities {
    this.assertOpen();
    const caps: NativeCapabilitiesStruct = {
      version: CAPABILITIES_VERSION,
      size: koffi.sizeof(this.bindings.capabilitiesType),
      supported_engines: null,
      supported_capabilities: null,
      supported_archs: null,
      ram_total_bytes: 0,
      ram_available_bytes: 0,
      has_apple_silicon: 0,
      has_cuda: 0,
      has_metal: 0,
      _reserved0: 0,
    };

    const status = this.bindings.octRuntimeCapabilities(this.runtime, caps);
    if (status !== OCT_STATUS_OK)
      throwStatus(
        this.bindings,
        status,
        "oct_runtime_capabilities",
        this.runtime,
      );

    try {
      return parseCapabilities(caps);
    } finally {
      this.bindings.octRuntimeCapabilitiesFree(caps);
    }
  }

  supports(capability: RuntimeCapability | string): boolean {
    return this.capabilities().supportedCapabilities.includes(
      capability as RuntimeCapability,
    );
  }

  cacheClearAll(): void {
    this.assertOpen();
    const status = this.bindings.octRuntimeCacheClearAll(this.runtime);
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_runtime_cache_clear_all", this.runtime);
    }
  }

  cacheClearCapability(capability: RuntimeCapability | string): void {
    this.assertOpen();
    const status = this.bindings.octRuntimeCacheClearCapability(
      this.runtime,
      capability,
    );
    if (status === OCT_STATUS_NOT_FOUND) return;
    if (status !== OCT_STATUS_OK) {
      throwStatus(
        this.bindings,
        status,
        "oct_runtime_cache_clear_capability",
        this.runtime,
      );
    }
  }

  cacheClearScope(scope: NativeCacheScope): void {
    this.assertOpen();
    normalizeCacheScope(scope);
    const status = this.bindings.octRuntimeCacheClearScope(this.runtime, scope);
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_runtime_cache_clear_scope", this.runtime);
    }
  }

  cacheIntrospect(): NativeCacheSnapshot {
    this.assertOpen();
    const buffer = Buffer.alloc(65536);
    const status = this.bindings.octRuntimeCacheIntrospect(
      this.runtime,
      buffer,
      buffer.length,
    );
    if (status !== OCT_STATUS_OK) {
      throwStatus(
        this.bindings,
        status,
        "oct_runtime_cache_introspect",
        this.runtime,
      );
    }
    const end = buffer.indexOf(0);
    const rawJson = buffer.toString("utf8", 0, end >= 0 ? end : buffer.length);
    if (!rawJson) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        "oct_runtime_cache_introspect returned an empty payload",
      );
    }
    const snapshot = parseNativeCacheSnapshot(rawJson);
    return snapshot;
  }

  requireCapability(capability: RuntimeCapability | string): void {
    if (this.supports(capability)) return;
    throw new NativeRuntimeError(
      OCT_STATUS_UNSUPPORTED,
      "RUNTIME_UNAVAILABLE",
      `Native runtime does not advertise required capability ${capability}; refusing to route to cloud or fake native support`,
    );
  }

  openModel(options: NativeModelOpenOptions): NativeModel {
    this.assertOpen();
    const out: [unknown] = [null];
    const status = this.bindings.octModelOpen(
      this.runtime,
      {
        version: 1,
        model_uri: options.modelUri,
        artifact_digest: options.artifactDigest ?? null,
        engine_hint: options.engineHint ?? null,
        policy_preset: options.policyPreset ?? null,
        accelerator_pref: options.acceleratorPref ?? 0,
        ram_budget_bytes: options.ramBudgetBytes ?? 0,
        user_data: null,
      },
      out,
    );
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_model_open", this.runtime);
    }
    if (out[0] == null) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        "oct_model_open returned OK with a NULL model handle",
      );
    }
    const model = new NativeModel(this, out[0]);
    this.models.add(model);
    return model;
  }

  openSession(options: NativeSessionOpenOptions): NativeSession {
    this.assertOpen();
    const borrowedModel = options.model ?? null;
    if (borrowedModel && borrowedModel._owner !== this) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "openSession: model was opened on a different NativeRuntime",
      );
    }
    if (borrowedModel && borrowedModel._isClosedOrInvalid()) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "openSession: model handle is closed or invalidated",
      );
    }
    const out: [unknown] = [null];
    const status = this.bindings.octSessionOpen(
      this.runtime,
      {
        version: 3,
        model_uri: options.modelUri ?? null,
        capability: options.capability,
        locality: options.locality ?? "local",
        policy_preset: options.policyPreset ?? null,
        speaker_id: options.speakerId ?? null,
        sample_rate_in: options.sampleRateIn ?? 16000,
        sample_rate_out: options.sampleRateOut ?? 16000,
        priority: options.priority ?? 0,
        user_data: null,
        request_id: options.requestId ?? null,
        route_id: options.routeId ?? null,
        trace_id: options.traceId ?? null,
        kv_prefix_key: options.kvPrefixKey ?? null,
        model: borrowedModel ? borrowedModel._handle : null,
      },
      out,
    );
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_session_open", this.runtime);
    }
    if (out[0] == null) {
      throw new NativeRuntimeError(
        OCT_STATUS_INTERNAL,
        "RUNTIME_UNAVAILABLE",
        "oct_session_open returned OK with a NULL session handle",
      );
    }
    const session = new NativeSession(this, out[0], options.capability, borrowedModel);
    this.sessions.add(session);
    return session;
  }

  close(): void {
    if (this.closed) return;
    for (const session of [...this.sessions]) {
      try {
        session.close();
      } catch {
        session._invalidateAfterRuntimeClose();
      }
    }
    for (const model of [...this.models]) {
      try {
        model.close();
      } catch {
        model._invalidateAfterRuntimeClose();
      }
    }
    this.sessions.clear();
    this.models.clear();
    this.bindings.octRuntimeClose(this.runtime);
    this.runtime = null;
    this.closed = true;
    this.bindings.lib.unload();
  }

  _detachSession(session: NativeSession): void {
    this.sessions.delete(session);
  }

  _detachModel(model: NativeModel): void {
    this.models.delete(model);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "Native runtime handle is closed",
      );
    }
  }
}

export class NativeSession {
  private closed = false;
  private handleInvalid = false;
  private readonly eventBuffer: any;

  constructor(
    public readonly _owner: NativeRuntime,
    public readonly _handle: unknown,
    public readonly capability: RuntimeCapability | string,
    private readonly borrowedModel: NativeModel | null = null,
  ) {
    this.eventBuffer = koffi.alloc(this.bindings.eventType, 1);
    this.borrowedModel?._addBorrower(this);
  }

  private get bindings(): NativeBindings {
    return (this._owner as unknown as { bindings: NativeBindings }).bindings;
  }

  _isClosedOrInvalid(): boolean {
    return this.closed || this.handleInvalid;
  }

  sendAudio(
    samples: Float32Array | number[],
    sampleRate = 16000,
    channels = 1,
  ): void {
    this.assertOpen();
    const pcm = samples instanceof Float32Array ? samples : new Float32Array(samples);
    if (channels <= 0) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "INVALID_INPUT",
        "sendAudio: channels must be greater than zero",
      );
    }
    if (pcm.length % channels !== 0) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "INVALID_INPUT",
        `sendAudio: sample count ${pcm.length} is not divisible by channels ${channels}`,
      );
    }
    const status = this.bindings.octSessionSendAudio(this._handle, {
      samples: koffi.as(pcm, "float *"),
      n_frames: pcm.length / channels,
      sample_rate: sampleRate,
      channels,
      _reserved0: 0,
    });
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_session_send_audio", this._handle);
    }
  }

  sendText(utf8: string): void {
    this.assertOpen();
    const status = this.bindings.octSessionSendText(this._handle, utf8);
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_session_send_text", this._handle);
    }
  }

  /**
   * Send an image to the session. v0.1.12 (ABI minor 11) — STUB SURFACE.
   *
   * BLOCKED_WITH_PROOF: this method is wired against the optional
   * oct_session_send_image FFI binding, but the embeddings.image capability
   * is NOT advertised by any released runtime — it stays in
   * kBlockedCapabilities until the image-embeddings adapter (SigLIP-base
   * int8 over sherpa-onnx-vendored onnxruntime) lands. Calling this method
   * always throws.
   *
   * Gating order (matches the Python loader's probe-session pattern):
   *   1. Runtime must advertise embeddings.image capability.
   *   2. Symbol must be resolved (non-null) — implies ABI minor >= 11.
   *
   * Both checks fail today by design. The method exists so SDK consumers
   * and reviewers can see the wired surface and watch the failure mode
   * flip from RUNTIME_UNAVAILABLE -> functional once the adapter PR lands.
   *
   * TODO(reviewer): remove this guard once
   *   - octomil-runtime advertises "embeddings.image" in oct_runtime_capabilities
   *   - REQUIRED_ABI.minor is bumped to 11 (separate decision)
   *   - a public Octomil.embeddings.image() facade exposes this method
   */
  sendImage(view: NativeImageView): void {
    this.assertOpen();

    // Capability gate — embeddings.image must be advertised.
    if (!this._owner.supports(RuntimeCapability.EmbeddingsImage)) {
      throw new NativeRuntimeError(
        OCT_STATUS_UNSUPPORTED,
        "RUNTIME_UNAVAILABLE",
        `Native runtime does not advertise required capability ${RuntimeCapability.EmbeddingsImage}; ` +
          `embeddings.image is BLOCKED_WITH_PROOF until the SigLIP adapter PR removes it from kBlockedCapabilities`,
      );
    }

    // Symbol gate — older runtimes (minor 10) won't have the binding.
    const sendImage = this.bindings.octSessionSendImage;
    const imageViewType = this.bindings.imageViewType;
    if (sendImage == null || imageViewType == null) {
      throw new NativeRuntimeError(
        OCT_STATUS_UNSUPPORTED,
        "RUNTIME_UNAVAILABLE",
        `Native runtime did not expose oct_session_send_image; ABI minor < ${OPTIONAL_ABI_MINOR_IMAGE} ` +
          `(capability ${RuntimeCapability.EmbeddingsImage})`,
      );
    }

    if (!view || !(view.bytes instanceof Uint8Array) || view.bytes.length === 0) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "INVALID_INPUT",
        "sendImage: view.bytes must be a non-empty Uint8Array",
      );
    }
    if (
      view.mime !== OCT_IMAGE_MIME_PNG &&
      view.mime !== OCT_IMAGE_MIME_JPEG &&
      view.mime !== OCT_IMAGE_MIME_WEBP &&
      view.mime !== OCT_IMAGE_MIME_RGB8
    ) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "INVALID_INPUT",
        `sendImage: view.mime ${view.mime} is not a recognised OCT_IMAGE_MIME_* value`,
      );
    }

    const status = sendImage(this._handle, {
      bytes: koffi.as(view.bytes, "uint8_t *"),
      n_bytes: view.bytes.length,
      mime: view.mime,
      _reserved0: 0,
    });
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_session_send_image", this._handle);
    }
  }

  pollEvent(timeoutMs = 0): NativeEvent {
    this.assertOpen();
    koffi.encode(this.eventBuffer, this.bindings.eventType, {
      version: 2,
      size: koffi.sizeof(this.bindings.eventType),
    });
    const status = this.bindings.octSessionPollEvent(
      this._handle,
      this.eventBuffer as NativeEventStruct,
      timeoutMs,
    );
    if (status !== OCT_STATUS_OK && status !== OCT_STATUS_TIMEOUT) {
      throwStatus(this.bindings, status, "oct_session_poll_event", this._handle);
    }
    const raw = koffi.decode(
      this.eventBuffer,
      this.bindings.eventType,
    ) as Record<string, unknown>;
    return parseNativeEvent(raw);
  }

  cancel(): number {
    if (this._isClosedOrInvalid()) return OCT_STATUS_CANCELLED;
    const status = this.bindings.octSessionCancel(this._handle);
    if (
      status !== OCT_STATUS_OK &&
      status !== OCT_STATUS_CANCELLED &&
      status !== OCT_STATUS_UNSUPPORTED
    ) {
      throwStatus(this.bindings, status, "oct_session_cancel", this._handle);
    }
    return status;
  }

  close(): void {
    if (this.closed) return;
    if (!this.handleInvalid) {
      this.bindings.octSessionClose(this._handle);
    }
    this.closed = true;
    this.borrowedModel?._releaseBorrower(this);
    this._owner._detachSession(this);
  }

  _invalidateAfterRuntimeClose(): void {
    this.handleInvalid = true;
    this.closed = true;
    this.borrowedModel?._releaseBorrower(this);
  }

  private assertOpen(): void {
    if (this.handleInvalid) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "session handle invalidated by parent NativeRuntime.close()",
      );
    }
    if (this.closed) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "session handle is closed",
      );
    }
  }
}

export class NativeModel {
  private closed = false;
  private handleInvalid = false;
  private borrowers = new Set<NativeSession>();

  constructor(
    public readonly _owner: NativeRuntime,
    public readonly _handle: unknown,
  ) {}

  _addBorrower(session: NativeSession): void {
    this.borrowers.add(session);
  }

  _isClosedOrInvalid(): boolean {
    return this.closed || this.handleInvalid;
  }

  _releaseBorrower(session: NativeSession): void {
    this.borrowers.delete(session);
  }

  warm(): void {
    this.assertOpen();
    const status = this.bindings.octModelWarm(this._handle);
    if (status !== OCT_STATUS_OK) {
      throwStatus(this.bindings, status, "oct_model_warm", this._handle);
    }
  }

  close(): number {
    if (this.closed) return OCT_STATUS_OK;
    if (this.handleInvalid) {
      this.closed = true;
      this._owner._detachModel(this);
      return OCT_STATUS_OK;
    }
    if (this.borrowers.size > 0) {
      return OCT_STATUS_BUSY;
    }
    const status = this.bindings.octModelClose(this._handle);
    if (status === OCT_STATUS_OK) {
      this.closed = true;
      this._owner._detachModel(this);
      return status;
    }
    if (status === OCT_STATUS_BUSY) {
      return status;
    }
    throwStatus(this.bindings, status, "oct_model_close", this._handle);
  }

  _invalidateAfterRuntimeClose(): void {
    this.handleInvalid = true;
    this.closed = true;
    this.borrowers.clear();
  }

  private assertOpen(): void {
    if (this.handleInvalid) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "model handle invalidated by parent NativeRuntime.close()",
      );
    }
    if (this.closed) {
      throw new NativeRuntimeError(
        OCT_STATUS_INVALID_INPUT,
        "RUNTIME_UNAVAILABLE",
        "model handle is closed",
      );
    }
  }

  private get bindings(): NativeBindings {
    return (this._owner as unknown as { bindings: NativeBindings }).bindings;
  }
}

export function readNativeCapabilities(
  options: NativeRuntimeOpenOptions = {},
): NativeRuntimeCapabilities {
  const runtime = NativeRuntime.open(options);
  try {
    return runtime.capabilities();
  } finally {
    runtime.close();
  }
}

export function requireNativeCapability(
  capability: RuntimeCapability | string,
  options: NativeRuntimeOpenOptions = {},
): NativeRuntimeCapabilities {
  const runtime = NativeRuntime.open(options);
  try {
    const capabilities = runtime.capabilities();
    if (
      !capabilities.supportedCapabilities.includes(
        capability as RuntimeCapability,
      )
    ) {
      throw new NativeRuntimeError(
        OCT_STATUS_UNSUPPORTED,
        "RUNTIME_UNAVAILABLE",
        `Native runtime does not advertise required capability ${capability}; refusing to route to cloud or fake native support`,
      );
    }
    return capabilities;
  } finally {
    runtime.close();
  }
}
