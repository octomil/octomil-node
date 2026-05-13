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
  } catch (error) {
    if (process.env.OCTOMIL_NATIVE_STUB_DEBUG) {
      console.error(error);
    }
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
  const abiMinor = options.abiMinor ?? 10;
  const capabilities = options.capabilities ?? ["chat.completion"];
  const engines = options.engines ?? ["llama_cpp"];
  const archs = options.archs ?? ["darwin-arm64"];

return `
#include <stddef.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct oct_runtime { int marker; uint32_t open_sessions; uint32_t open_models; } oct_runtime_t;
typedef struct oct_model { int marker; int borrowers; oct_runtime_t *runtime; } oct_model_t;
typedef struct oct_session { int marker; uint32_t step; char capability[64]; oct_model_t *model; oct_runtime_t *runtime; } oct_session_t;
typedef uint32_t oct_status_t;
typedef uint32_t oct_event_type_t;

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

typedef struct {
  uint32_t version;
  const char *model_uri;
  const char *artifact_digest;
  const char *engine_hint;
  const char *policy_preset;
  uint32_t accelerator_pref;
  uint64_t ram_budget_bytes;
  void *user_data;
} oct_model_config_t;

typedef struct {
  uint32_t version;
  const char *model_uri;
  const char *capability;
  const char *locality;
  const char *policy_preset;
  const char *speaker_id;
  uint32_t sample_rate_in;
  uint32_t sample_rate_out;
  uint32_t priority;
  void *user_data;
  const char *request_id;
  const char *route_id;
  const char *trace_id;
  const char *kv_prefix_key;
  oct_model_t *model;
} oct_session_config_t;

typedef struct {
  const float *samples;
  uint32_t n_frames;
  uint32_t sample_rate;
  uint16_t channels;
  uint16_t _reserved0;
} oct_audio_view_t;

typedef struct {
  const uint8_t *pcm;
  uint32_t n_bytes;
  uint32_t sample_rate;
  uint32_t sample_format;
  uint16_t channels;
  uint8_t is_final;
  uint8_t _reserved0;
} oct_audio_chunk_t;

typedef struct {
  const char *utf8;
  uint32_t n_bytes;
} oct_transcript_chunk_t;

typedef struct {
  const char *code;
  const char *message;
  uint32_t error_code;
  uint32_t _reserved0;
} oct_error_t;

typedef struct {
  const char *engine;
  const char *model_digest;
  const char *locality;
  const char *streaming_mode;
  const char *runtime_build_tag;
} oct_session_started_t;

typedef struct {
  float setup_ms;
  float engine_first_chunk_ms;
  float e2e_first_chunk_ms;
  float total_latency_ms;
  float queued_ms;
  uint32_t observed_chunks;
  uint8_t capability_verified;
  uint8_t _reserved0;
  uint16_t _reserved1;
  uint32_t terminal_status;
} oct_session_completed_t;

typedef struct {
  uint32_t n_frames_dropped;
  uint32_t sample_rate;
  uint16_t channels;
  uint16_t _reserved0;
  const char *reason;
  uint64_t dropped_at_ns;
} oct_input_dropped_t;

typedef struct {
  const char *engine;
  const char *model_id;
  const char *artifact_digest;
  uint64_t load_ms;
  uint64_t warm_ms;
  const char *policy_preset;
  void *config_user_data;
  const char *source;
} oct_model_loaded_t;

typedef struct {
  const char *engine;
  const char *model_id;
  const char *artifact_digest;
  uint64_t freed_bytes;
  const char *reason;
  void *config_user_data;
} oct_model_evicted_t;

typedef struct {
  const char *layer;
  uint32_t saved_tokens;
  uint32_t _reserved0;
} oct_cache_t;

typedef struct {
  uint32_t queue_position;
  uint32_t queue_depth;
} oct_queued_t;

typedef struct {
  uint32_t preempted_by_priority;
  uint32_t _reserved0;
  const char *reason;
} oct_preempted_t;

typedef struct {
  uint64_t ram_available_bytes;
  uint8_t severity;
  uint8_t _reserved0;
  uint16_t _reserved1;
  uint32_t _reserved2;
} oct_memory_pressure_t;

typedef struct {
  uint8_t state;
  uint8_t _reserved0;
  uint16_t _reserved1;
  uint32_t _reserved2;
} oct_thermal_state_t;

typedef struct {
  uint32_t timeout_ms;
  uint32_t _reserved0;
  const char *phase;
} oct_watchdog_timeout_t;

typedef struct {
  const char *name;
  double value;
} oct_metric_t;

typedef struct {
  const float *values;
  uint32_t n_dim;
  uint32_t n_input_tokens;
  uint32_t index;
  uint32_t pooling_type;
  uint8_t is_normalized;
  uint8_t _reserved0;
  uint16_t _reserved1;
} oct_embedding_vector_t;

typedef struct {
  uint32_t transition_kind;
  uint32_t timestamp_ms;
  float confidence;
  uint32_t _reserved0;
} oct_vad_transition_t;

typedef struct {
  const char *utf8;
  uint32_t n_bytes;
  uint32_t start_ms;
  uint32_t end_ms;
  uint32_t segment_index;
  uint8_t is_final;
  uint8_t _reserved0;
  uint16_t _reserved1;
} oct_transcript_segment_t;

typedef struct {
  const char *utf8;
  uint32_t n_bytes;
  uint32_t n_segments;
  uint32_t duration_ms;
  uint32_t _reserved0;
  uint32_t _reserved1;
} oct_transcript_final_t;

typedef struct {
  uint32_t start_ms;
  uint32_t end_ms;
  uint16_t speaker_id;
  uint16_t _reserved0;
  uint32_t _reserved1;
  const char *speaker_label;
} oct_diarization_segment_t;

typedef struct {
  const uint8_t *pcm;
  uint32_t n_bytes;
  uint32_t sample_rate;
  uint32_t sample_format;
  uint16_t channels;
  uint8_t is_final;
  uint8_t _reserved0;
} oct_tts_audio_chunk_t;

typedef union {
  oct_audio_chunk_t audio_chunk;
  oct_transcript_chunk_t transcript_chunk;
  oct_error_t error;
  oct_session_started_t session_started;
  oct_session_completed_t session_completed;
  oct_input_dropped_t input_dropped;
  oct_model_loaded_t model_loaded;
  oct_model_evicted_t model_evicted;
  oct_cache_t cache;
  oct_queued_t queued;
  oct_preempted_t preempted;
  oct_memory_pressure_t memory_pressure;
  oct_thermal_state_t thermal_state;
  oct_watchdog_timeout_t watchdog_timeout;
  oct_metric_t metric;
  oct_embedding_vector_t embedding_vector;
  oct_vad_transition_t vad_transition;
  oct_transcript_segment_t transcript_segment;
  oct_transcript_final_t transcript_final;
  oct_diarization_segment_t diarization_segment;
  oct_tts_audio_chunk_t tts_audio_chunk;
} oct_event_data_t;

typedef struct {
  uint32_t version;
  size_t size;
  oct_event_type_t type;
  uint64_t monotonic_ns;
  void *user_data;
  oct_event_data_t data;
  const char *request_id;
  const char *route_id;
  const char *trace_id;
  const char *engine_version;
  const char *adapter_version;
  const char *accelerator;
  const char *artifact_digest;
  uint8_t cache_was_hit;
  uint8_t _reserved0;
  uint16_t _reserved1;
  uint32_t _reserved2;
} oct_event_t;

static const char *stub_runtime_build_tag = "stub-runtime";
static const char *stub_streaming_mode = "stream";
static const char *stub_model_digest = "stub-model-digest";
static const char *stub_engine_name = "llama_cpp";
static const char *stub_locality = "local";
static const char *stub_adapter_version = "stub-adapter";
static const char *stub_engine_version = "stub-engine";
static const char *stub_accelerator = "cpu";
static const char *stub_artifact_digest = "stub-artifact";
static const char *stub_empty = "";

${cStringArray("stub_engines", engines)}
${cStringArray("stub_capabilities", capabilities)}
${cStringArray("stub_archs", archs)}

static void init_event(oct_event_t *out) {
  memset(out, 0, sizeof(*out));
  out->version = 2;
  out->size = sizeof(oct_event_t);
  out->request_id = stub_empty;
  out->route_id = stub_empty;
  out->trace_id = stub_empty;
  out->engine_version = stub_engine_version;
  out->adapter_version = stub_adapter_version;
  out->accelerator = stub_accelerator;
  out->artifact_digest = stub_artifact_digest;
}

static void set_started(oct_event_t *out) {
  init_event(out);
  out->type = 1;
  out->data.session_started.engine = stub_engine_name;
  out->data.session_started.model_digest = stub_model_digest;
  out->data.session_started.locality = stub_locality;
  out->data.session_started.streaming_mode = stub_streaming_mode;
  out->data.session_started.runtime_build_tag = stub_runtime_build_tag;
}

static void set_completed(oct_event_t *out) {
  init_event(out);
  out->type = 8;
  out->data.session_completed.setup_ms = 1.0f;
  out->data.session_completed.engine_first_chunk_ms = 2.0f;
  out->data.session_completed.e2e_first_chunk_ms = 3.0f;
  out->data.session_completed.total_latency_ms = 4.0f;
  out->data.session_completed.queued_ms = 0.0f;
  out->data.session_completed.observed_chunks = 1;
  out->data.session_completed.capability_verified = 1;
  out->data.session_completed.terminal_status = 0;
}

static void set_transcript_chunk(oct_event_t *out) {
  init_event(out);
  out->type = 3;
  out->data.transcript_chunk.utf8 = "hello";
  out->data.transcript_chunk.n_bytes = 5;
}

static void set_embedding_vector(oct_event_t *out) {
  static float values[] = { 0.25f, 0.75f };
  init_event(out);
  out->type = 20;
  out->data.embedding_vector.values = values;
  out->data.embedding_vector.n_dim = 2;
  out->data.embedding_vector.n_input_tokens = 6;
  out->data.embedding_vector.index = 0;
  out->data.embedding_vector.pooling_type = 1;
  out->data.embedding_vector.is_normalized = 1;
}

static void set_transcript_segment(oct_event_t *out) {
  init_event(out);
  out->type = 21;
  out->data.transcript_segment.utf8 = "segment";
  out->data.transcript_segment.n_bytes = 7;
  out->data.transcript_segment.start_ms = 0;
  out->data.transcript_segment.end_ms = 1000;
  out->data.transcript_segment.segment_index = 0;
  out->data.transcript_segment.is_final = 1;
}

static void set_transcript_final(oct_event_t *out) {
  init_event(out);
  out->type = 22;
  out->data.transcript_final.utf8 = "segment";
  out->data.transcript_final.n_bytes = 7;
  out->data.transcript_final.n_segments = 1;
  out->data.transcript_final.duration_ms = 1000;
}

static void set_vad_transition(oct_event_t *out) {
  init_event(out);
  out->type = 24;
  out->data.vad_transition.transition_kind = 1;
  out->data.vad_transition.timestamp_ms = 250;
  out->data.vad_transition.confidence = 0.9f;
}

static void set_diarization_segment(oct_event_t *out) {
  init_event(out);
  out->type = 25;
  out->data.diarization_segment.start_ms = 0;
  out->data.diarization_segment.end_ms = 1100;
  out->data.diarization_segment.speaker_id = 7;
  out->data.diarization_segment.speaker_label = "SPEAKER_00";
}

static void set_tts_chunk(oct_event_t *out) {
  static const uint8_t pcm[] = { 1, 2, 3, 4 };
  init_event(out);
  out->type = 23;
  out->data.tts_audio_chunk.pcm = pcm;
  out->data.tts_audio_chunk.n_bytes = sizeof(pcm);
  out->data.tts_audio_chunk.sample_rate = 24000;
  out->data.tts_audio_chunk.sample_format = 2;
  out->data.tts_audio_chunk.channels = 1;
  out->data.tts_audio_chunk.is_final = 1;
}

static int is_transcription_capability(const char *capability) {
  return strcmp(capability, "audio.transcription") == 0 ||
         strcmp(capability, "audio.stt.batch") == 0 ||
         strcmp(capability, "audio.stt.stream") == 0;
}

uint32_t oct_runtime_abi_version_major(void) { return 0; }
uint32_t oct_runtime_abi_version_minor(void) { return ${abiMinor}; }
uint32_t oct_runtime_abi_version_patch(void) { return 0; }
size_t oct_runtime_config_size(void) { return sizeof(oct_runtime_config_t); }
size_t oct_capabilities_size(void) { return sizeof(oct_capabilities_t); }
size_t oct_model_config_size(void) { return sizeof(oct_model_config_t); }
size_t oct_session_config_size(void) { return sizeof(oct_session_config_t); }
size_t oct_audio_view_size(void) { return sizeof(oct_audio_view_t); }
size_t oct_event_size(void) { return sizeof(oct_event_t); }

oct_status_t oct_runtime_open(const oct_runtime_config_t *config, oct_runtime_t **out) {
  if (out == NULL) return 1;
  *out = NULL;
  if (config == NULL || config->version != 1) return 1;
  oct_runtime_t *runtime = (oct_runtime_t *)malloc(sizeof(oct_runtime_t));
  if (runtime == NULL) return 7;
  runtime->marker = 42;
  runtime->open_sessions = 0;
  runtime->open_models = 0;
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

oct_status_t oct_runtime_cache_clear_all(oct_runtime_t *runtime) {
  (void)runtime;
  return 2;
}

oct_status_t oct_runtime_cache_clear_capability(oct_runtime_t *runtime, const char *capability_id) {
  (void)runtime;
  (void)capability_id;
  return 2;
}

oct_status_t oct_runtime_cache_clear_scope(oct_runtime_t *runtime, uint32_t scope_id) {
  (void)runtime;
  (void)scope_id;
  return 2;
}

oct_status_t oct_runtime_cache_introspect(oct_runtime_t *runtime, char *out_json_buf, size_t buf_len) {
  if (runtime == NULL || out_json_buf == NULL || buf_len == 0) return 1;
  const char *payload = "{\\"version\\":1,\\"is_stub\\":true,\\"entries\\":[]}";
  int written = snprintf(out_json_buf, buf_len, "%s", payload);
  return written < 0 || (size_t)written >= buf_len ? 1 : 0;
}

oct_status_t oct_model_open(oct_runtime_t *runtime, const oct_model_config_t *config, oct_model_t **out) {
  if (runtime == NULL || config == NULL || out == NULL || config->version != 1 || config->model_uri == NULL || config->model_uri[0] == 0) return 1;
  oct_model_t *model = (oct_model_t *)malloc(sizeof(oct_model_t));
  if (model == NULL) return 7;
  model->marker = 77;
  model->borrowers = 0;
  model->runtime = runtime;
  runtime->open_models += 1;
  *out = model;
  return 0;
}

oct_status_t oct_model_warm(oct_model_t *model) {
  if (model == NULL) return 1;
  return 0;
}

oct_status_t oct_model_close(oct_model_t *model) {
  if (model == NULL) return 1;
  if (model->borrowers > 0) return 4;
  if (model->runtime != NULL && model->runtime->open_models > 0) {
    model->runtime->open_models -= 1;
  }
  free(model);
  return 0;
}

oct_status_t oct_session_open(oct_runtime_t *runtime, const oct_session_config_t *config, oct_session_t **out) {
  if (runtime == NULL || config == NULL || out == NULL || config->version != 3 || config->capability == NULL) return 1;
  int supported = 0;
  for (size_t i = 0; stub_capabilities[i] != NULL; i++) {
    if (strcmp(stub_capabilities[i], config->capability) == 0) {
      supported = 1;
      break;
    }
  }
  if (!supported) return 2;
  if ((strcmp(config->capability, "chat.completion") == 0 || strcmp(config->capability, "chat.stream") == 0) && config->model == NULL) return 1;
  oct_session_t *session = (oct_session_t *)malloc(sizeof(oct_session_t));
  if (session == NULL) return 7;
  session->marker = 91;
  session->step = 0;
  session->model = config->model;
  session->runtime = runtime;
  if (session->model != NULL) {
    session->model->borrowers += 1;
  }
  strncpy(session->capability, config->capability, sizeof(session->capability) - 1);
  session->capability[sizeof(session->capability) - 1] = 0;
  runtime->open_sessions += 1;
  *out = session;
  return 0;
}

oct_status_t oct_session_send_audio(oct_session_t *session, const oct_audio_view_t *audio) {
  if (session == NULL || audio == NULL || audio->sample_rate == 0) return 1;
  return 0;
}

oct_status_t oct_session_send_text(oct_session_t *session, const char *utf8) {
  if (session == NULL || utf8 == NULL) return 1;
  return 0;
}

oct_status_t oct_session_poll_event(oct_session_t *session, oct_event_t *out, uint32_t timeout_ms) {
  (void)timeout_ms;
  if (session == NULL || out == NULL) return 1;
  if (strcmp(session->capability, "chat.completion") == 0 || strcmp(session->capability, "chat.stream") == 0) {
    if (session->step == 0) { set_started(out); session->step = 1; return 0; }
    if (session->step == 1) { set_transcript_chunk(out); session->step = 2; return 0; }
    if (session->step == 2) { set_completed(out); session->step = 3; return 0; }
    out->type = 0; return 5;
  }
  if (strcmp(session->capability, "embeddings.text") == 0 || strcmp(session->capability, "audio.speaker.embedding") == 0) {
    if (session->step == 0) { set_started(out); session->step = 1; return 0; }
    if (session->step == 1) { set_embedding_vector(out); session->step = 2; return 0; }
    if (session->step == 2) { set_completed(out); session->step = 3; return 0; }
    out->type = 0; return 5;
  }
  if (is_transcription_capability(session->capability)) {
    if (session->step == 0) { set_started(out); session->step = 1; return 0; }
    if (session->step == 1) { set_transcript_segment(out); session->step = 2; return 0; }
    if (session->step == 2) { set_transcript_final(out); session->step = 3; return 0; }
    if (session->step == 3) { set_completed(out); session->step = 4; return 0; }
    out->type = 0; return 5;
  }
  if (strcmp(session->capability, "audio.vad") == 0) {
    if (session->step == 0) { set_started(out); session->step = 1; return 0; }
    if (session->step == 1) { set_vad_transition(out); session->step = 2; return 0; }
    if (session->step == 2) { set_completed(out); session->step = 3; return 0; }
    out->type = 0; return 5;
  }
  if (strcmp(session->capability, "audio.diarization") == 0) {
    if (session->step == 0) { set_started(out); session->step = 1; return 0; }
    if (session->step == 1) { set_diarization_segment(out); session->step = 2; return 0; }
    if (session->step == 2) { set_completed(out); session->step = 3; return 0; }
    out->type = 0; return 5;
  }
  if (strcmp(session->capability, "audio.tts.batch") == 0 || strcmp(session->capability, "audio.tts.stream") == 0) {
    if (session->step == 0) { set_started(out); session->step = 1; return 0; }
    if (session->step == 1) { set_tts_chunk(out); session->step = 2; return 0; }
    if (session->step == 2) { set_completed(out); session->step = 3; return 0; }
    out->type = 0; return 5;
  }
  out->type = 0;
  return 5;
}

oct_status_t oct_session_cancel(oct_session_t *session) {
  if (session == NULL) return 1;
  session->step = 999;
  return 0;
}

void oct_session_close(oct_session_t *session) {
  if (session == NULL) return;
  if (session->model != NULL) {
    session->model->borrowers -= 1;
  }
  if (session->runtime != NULL && session->runtime->open_sessions > 0) {
    session->runtime->open_sessions -= 1;
  }
  free(session);
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
