import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import koffi, { type IKoffiLib } from "koffi";
import { RuntimeCapability } from "../../_generated/runtime_capability.js";
import { OctomilError, type OctomilErrorCode } from "../../types.js";

export const ENV_RUNTIME_DYLIB = "OCTOMIL_RUNTIME_DYLIB";
export const ENV_RUNTIME_CACHE_DIR = "OCTOMIL_RUNTIME_CACHE_DIR";
export const REQUIRED_ABI = { major: 0, minor: 9, patch: 0 } as const;

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

interface NativeBindings {
  libraryPath: string;
  lib: IKoffiLib;
  runtimeConfigType: ReturnType<typeof koffi.struct>;
  capabilitiesType: ReturnType<typeof koffi.struct>;
  runtimePtrType: ReturnType<typeof koffi.pointer>;
  octRuntimeOpen: (config: NativeRuntimeConfig, out: [unknown]) => number;
  octRuntimeClose: (runtime: unknown) => void;
  octRuntimeCapabilities: (
    runtime: unknown,
    out: NativeCapabilitiesStruct,
  ) => number;
  octRuntimeCapabilitiesFree: (caps: NativeCapabilitiesStruct) => void;
  octRuntimeAbiVersionMajor: () => number;
  octRuntimeAbiVersionMinor: () => number;
  octRuntimeAbiVersionPatch: () => number;
  octRuntimeConfigSize: () => number;
  octCapabilitiesSize: () => number;
  octRuntimeLastError: (
    runtime: unknown,
    buffer: Buffer,
    buflen: number,
  ) => number;
  octLastThreadError: (buffer: Buffer, buflen: number) => number;
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

  const candidates: string[] = [];
  for (const versionDir of readdirSync(root).sort(compareVersionDirs)) {
    const versionPath = join(root, versionDir);
    try {
      if (!statSync(versionPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const libDir = join(versionPath, "lib");
    if (!isFile(join(libDir, CACHE_SENTINEL))) continue;
    for (const name of CACHE_LIB_NAMES) {
      const candidate = join(libDir, name);
      if (isFile(candidate)) candidates.push(candidate);
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
  const newest = candidates[candidates.length - 1];
  if (newest) return newest;

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
  const runtimePtrType = koffi.pointer(runtimeType);
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

  try {
    const bindings: NativeBindings = {
      libraryPath,
      lib,
      runtimeConfigType,
      capabilitiesType,
      runtimePtrType,
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
      octRuntimeLastError: lib.func("oct_runtime_last_error", "int", [
        runtimePtrType,
        "char *",
        "size_t",
      ]) as NativeBindings["octRuntimeLastError"],
      octLastThreadError: lib.func("oct_last_thread_error", "int", [
        "char *",
        "size_t",
      ]) as NativeBindings["octLastThreadError"],
    };
    validateBindings(bindings);
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
}

function readAbi(bindings: NativeBindings): NativeRuntimeAbiVersion {
  return {
    major: Number(bindings.octRuntimeAbiVersionMajor()),
    minor: Number(bindings.octRuntimeAbiVersionMinor()),
    patch: Number(bindings.octRuntimeAbiVersionPatch()),
  };
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

  requireCapability(capability: RuntimeCapability | string): void {
    if (this.supports(capability)) return;
    throw new NativeRuntimeError(
      OCT_STATUS_UNSUPPORTED,
      "RUNTIME_UNAVAILABLE",
      `Native runtime does not advertise required capability ${capability}; refusing to route to cloud or fake native support`,
    );
  }

  close(): void {
    if (this.closed) return;
    this.bindings.octRuntimeClose(this.runtime);
    this.runtime = null;
    this.closed = true;
    this.bindings.lib.unload();
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
