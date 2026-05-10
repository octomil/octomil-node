import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NativeRuntimeStubOptions {
  abiMinor?: number;
  capabilities?: string[];
  engines?: string[];
  archs?: string[];
}

export function buildNativeRuntimeStub(
  options: NativeRuntimeStubOptions = {},
): string | null {
  const compiler = findCompiler();
  if (!compiler) return null;

  const dir = mkdtempSync(join(tmpdir(), "octomil-node-native-runtime-"));
  const sourcePath = join(dir, "runtime_stub.c");
  const libraryPath = join(dir, libraryName());

  writeFileSync(sourcePath, stubSource(options), "utf8");
  const args =
    process.platform === "darwin"
      ? ["-dynamiclib", "-fPIC", sourcePath, "-o", libraryPath]
      : ["-shared", "-fPIC", sourcePath, "-o", libraryPath];

  try {
    execFileSync(compiler, args, { stdio: "pipe" });
  } catch {
    return null;
  }

  return libraryPath;
}

function findCompiler(): string | null {
  for (const candidate of ["cc", "clang", "gcc"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next compiler candidate.
    }
  }
  return null;
}

function libraryName(): string {
  if (process.platform === "darwin") return "liboctomil-runtime.dylib";
  if (process.platform === "win32") return "octomil-runtime.dll";
  return "liboctomil-runtime.so";
}

function cString(value: string): string {
  return JSON.stringify(value);
}

function cStringArray(name: string, values: string[]): string {
  const entries = [...values.map(cString), "NULL"].join(", ");
  return `static const char *${name}[] = { ${entries} };`;
}

function stubSource(options: NativeRuntimeStubOptions): string {
  const abiMinor = options.abiMinor ?? 9;
  const capabilities = options.capabilities ?? ["chat.completion"];
  const engines = options.engines ?? ["llama_cpp"];
  const archs = options.archs ?? ["darwin-arm64"];

  return `
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct oct_runtime { int marker; } oct_runtime_t;
typedef uint32_t oct_status_t;

typedef struct {
  uint32_t version;
  const char *artifact_root;
  void *telemetry_sink;
  void *telemetry_user_data;
  uint32_t max_sessions;
} oct_runtime_config_t;

typedef struct {
  uint32_t version;
  size_t size;
  const char **supported_engines;
  const char **supported_capabilities;
  const char **supported_archs;
  uint64_t ram_total_bytes;
  uint64_t ram_available_bytes;
  uint8_t has_apple_silicon;
  uint8_t has_cuda;
  uint8_t has_metal;
  uint8_t _reserved0;
} oct_capabilities_t;

${cStringArray("stub_engines", engines)}
${cStringArray("stub_capabilities", capabilities)}
${cStringArray("stub_archs", archs)}

uint32_t oct_runtime_abi_version_major(void) { return 0; }
uint32_t oct_runtime_abi_version_minor(void) { return ${abiMinor}; }
uint32_t oct_runtime_abi_version_patch(void) { return 0; }
size_t oct_runtime_config_size(void) { return sizeof(oct_runtime_config_t); }
size_t oct_capabilities_size(void) { return sizeof(oct_capabilities_t); }

oct_status_t oct_runtime_open(const oct_runtime_config_t *config, oct_runtime_t **out) {
  if (out == NULL) return 1;
  *out = NULL;
  if (config == NULL || config->version != 1) return 1;
  oct_runtime_t *runtime = (oct_runtime_t *)malloc(sizeof(oct_runtime_t));
  if (runtime == NULL) return 7;
  runtime->marker = 42;
  *out = runtime;
  return 0;
}

void oct_runtime_close(oct_runtime_t *runtime) {
  free(runtime);
}

oct_status_t oct_runtime_capabilities(oct_runtime_t *runtime, oct_capabilities_t *out) {
  if (runtime == NULL || out == NULL) return 1;
  out->version = 1;
  out->size = sizeof(oct_capabilities_t);
  out->supported_engines = stub_engines;
  out->supported_capabilities = stub_capabilities;
  out->supported_archs = stub_archs;
  out->ram_total_bytes = 17179869184ULL;
  out->ram_available_bytes = 8589934592ULL;
  out->has_apple_silicon = 1;
  out->has_cuda = 0;
  out->has_metal = 1;
  out->_reserved0 = 0;
  return 0;
}

void oct_runtime_capabilities_free(oct_capabilities_t *caps) {
  (void)caps;
}

int oct_runtime_last_error(oct_runtime_t *runtime, char *buf, size_t buflen) {
  (void)runtime;
  const char *msg = "stub runtime error";
  size_t n = strlen(msg);
  if (buf == NULL || buflen == 0) return -1;
  if (n >= buflen) n = buflen - 1;
  memcpy(buf, msg, n);
  buf[n] = 0;
  return (int)n;
}

int oct_last_thread_error(char *buf, size_t buflen) {
  const char *msg = "stub thread error";
  size_t n = strlen(msg);
  if (buf == NULL || buflen == 0) return -1;
  if (n >= buflen) n = buflen - 1;
  memcpy(buf, msg, n);
  buf[n] = 0;
  return (int)n;
}
`;
}
