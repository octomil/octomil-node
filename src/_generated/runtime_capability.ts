// Auto-generated from octomil-contracts runtime_capability.json. Do not edit.
//
// Source of truth for capability strings used in BOTH directions of the runtime ABI:
//   (a) advertised via oct_runtime_capabilities().supported_capabilities[]
//   (b) requested via oct_session_config_t.capability

export enum RuntimeCapability {
  AudioDiarization = "audio.diarization",
  AudioRealtimeSession = "audio.realtime.session",
  AudioSpeakerEmbedding = "audio.speaker.embedding",
  AudioSttBatch = "audio.stt.batch",
  AudioSttStream = "audio.stt.stream",
  AudioTranscription = "audio.transcription",
  AudioTtsBatch = "audio.tts.batch",
  AudioTtsStream = "audio.tts.stream",
  AudioVad = "audio.vad",
  CacheIntrospect = "cache.introspect",
  ChatCompletion = "chat.completion",
  ChatStream = "chat.stream",
  EmbeddingsImage = "embeddings.image",
  EmbeddingsText = "embeddings.text",
  IndexVectorQuery = "index.vector.query",
}
