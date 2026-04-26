# Changelog

## 1.5.0 (2026-04-26)

### Features

- **Prepare-lifecycle planner introspection.** New `Octomil.prepare({ model, capability })` async method on the facade. Resolves a runtime plan, finds the local `sdk_runtime` candidate, and returns a structured `PrepareOutcome` with `preparePolicy`, `prepareRequired`, `downloadUrls`, `requiredFiles`, `digest`, `manifestUri`, and `prepared` (always `false` until the Node SDK grows its own downloader).
- **`canPrepareCandidate(candidate)`** pure inspection helper for routing layers. Mirrors Python's `PrepareManager.can_prepare`: structural checks for digest + download_urls, no-traversal in `required_files`, no NUL/empty `artifact_id`, no multi-file artifacts (per-file manifest is a follow-up).
- **`PREPAREABLE_CAPABILITIES`** exported. Today: `{tts}` only — in lock-step with Python `4.10.0`. Other capabilities will be added once their backends consume the prepared `model_dir`.

### Notes

- The Node SDK does not materialize artifacts on its own yet. The supported way to actually fetch on Node is to invoke the Python CLI's `octomil prepare` from the host process. A future release will add a Node durable downloader and flip `PrepareOutcome.prepared` to `true`.
- `prepare_required=false` candidates with no `artifact` plan now return a no-files outcome with the candidate's engine id (e.g. `"ollama"`) instead of crashing on `candidate.artifact!`.
- Empty `required_files` is correctly accepted as a single-file artifact.

## 1.4.0

- Unified `audioSpeech.create({...})` facade routing through the runtime planner; cloud, hosted, and local-runner paths share one surface.
- Hosted `/v1/audio/speech` cutover (Convention A path); legacy fallbacks rejected.
- TTS SDK release plumbing.
