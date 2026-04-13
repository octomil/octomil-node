# Architecture — octomil-node

## Repo Responsibility

Node.js / server-side SDK for the Octomil platform. Owns:

- **Hosted API client** — Chat, completions, embeddings, responses, model catalog
- **Local runner adapter** — Bridge to on-device inference engines via local runner protocol
- **Unified facade** — Single entry point (`src/facade.ts`) routing to hosted or local backends
- **Streaming** — SSE/chunked streaming for chat and responses
- **Telemetry** — OpenTelemetry span instrumentation for inference calls
- **Device context** — Runtime device profiling (platform, memory, accelerators)

## Module Layout

```
src/
├── _generated/          # Enum types from octomil-contracts — DO NOT HAND-EDIT
├── audio/               # Audio transcription client
├── manifest/            # Engine manifest types and resolution
├── runtime/             # Local runtime engine interfaces
├── text/                # Text generation helpers
├── facade.ts            # Unified SDK entry point (hosted + local routing)
├── client.ts            # Hosted API client
├── chat.ts              # Chat completions
├── embeddings.ts        # Embedding API
├── responses.ts         # Responses API (OpenAI-compatible)
├── responses-runtime.ts # Local responses runtime
├── responses-tools.ts   # Tool-use for responses
├── streaming.ts         # SSE/chunk stream helpers
├── routing.ts           # Smart routing (local vs cloud)
├── query-routing.ts     # Query-level routing decisions
├── model.ts             # Model resolution and references
├── model-ref.ts         # Model reference types
├── models.ts            # Model listing/info
├── model-downloader.ts  # Model artifact download
├── local.ts             # Local inference adapter
├── inference-engine.ts  # Engine abstraction interface
├── device-context.ts    # Device capability detection
├── telemetry.ts         # OpenTelemetry instrumentation
├── auth-config.ts       # Auth configuration (API key, publishable key)
├── configure.ts         # SDK configuration
├── control.ts           # Control plane client
├── federation.ts        # Federated learning client
├── training.ts          # Training round client
├── types.ts             # Shared type definitions
└── index.ts             # Public API exports

tests/
├── conformance/         # Contract conformance tests
├── integration/         # Integration tests
└── *.test.ts            # Unit tests (mirror src/ structure)
```

## Boundary Rules

- **`src/_generated/`** is machine-generated from `octomil-contracts`. Never hand-edit.
- **`facade.ts`** is the primary entry point — new capabilities route through here.
- **Streaming must be engine-agnostic**: `streaming.ts` handles SSE framing; engines yield chunks.
- **No server-side dependencies in client code**: This SDK runs in Node.js server environments; do not import browser-only APIs.

## Public API Surfaces

- Default export from `src/index.ts` — the `Octomil` class and facade
- Chat completions: `chat.ts`
- Embeddings: `embeddings.ts`
- Responses: `responses.ts`
- Audio: `audio/`
- Streaming helpers: `streaming.ts`

## Generated Code

Location: `src/_generated/`

Generated from `octomil-contracts/enums/*.yaml` via codegen. All enum types (device platform, artifact format, runtime executor, etc.) live here.

**Do not hand-edit.** Run codegen from `octomil-contracts` to update.

## Source-of-Truth Dependencies

| Dependency | Source |
|---|---|
| Enum definitions | `octomil-contracts/enums/*.yaml` |
| Engine manifest | `octomil-contracts/fixtures/core/engine_manifest.json` |
| API semantics | `octomil-contracts/schemas/` |
| Conformance tests | `octomil-contracts/conformance/` |

## Test Commands

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Type check
pnpm typecheck

# Lint
pnpm lint

# Format
pnpm format

# Build
pnpm build
```

Tests use **Vitest**. Test files live in `tests/` and mirror `src/` structure.

## Review Checklist

- [ ] New enum value: was it added to `octomil-contracts` first, then regenerated?
- [ ] Facade change: does it handle both hosted and local paths?
- [ ] Streaming change: does it work for both SSE and chunked responses?
- [ ] New export: is it added to `src/index.ts`?
- [ ] Type change: does `pnpm typecheck` pass?
- [ ] Conformance: do `tests/conformance/` tests still pass?
