# @octomil/sdk (Node.js)

> **Status:** v0.1.0 beta — publishable as `@octomil/sdk`.

Node.js SDK for on-device AI: ONNX inference, structured responses API, chat completions, control plane integration, model catalog, audio transcription, text prediction, query routing, and telemetry.

## What's implemented

| Feature | Status |
|---------|--------|
| Responses API (create + stream) | Implemented — multi-turn via previousResponseId, tool calls, multimodal |
| Chat API (create + stream + threads) | Implemented — delegates to ResponsesClient, OpenAI-compatible |
| ONNX inference (local) | Implemented — via onnxruntime-node |
| Embeddings (cloud) | Implemented |
| Streaming (cloud SSE) | Implemented — AsyncGenerator of StreamToken |
| Control plane (register, heartbeat, sync) | Implemented — full desired state + observed state |
| AppManifest + ModelCatalogService | Implemented — capability-driven, bundled/managed/cloud delivery |
| Audio transcription | Implemented — requires manifest runtime |
| Text prediction | Implemented — requires manifest runtime |
| Query routing | Implemented — policy-based + server routing |
| Runtime planner | Implemented — server-assisted engine selection, route metadata |
| Device capabilities | Implemented — RAM-based device class, accelerator detection |
| Telemetry | Implemented — OTLP batched reporter |
| Tool runner | Implemented — automated multi-turn tool call loop |
| configure() (silent registration) | Implemented — background registration with backoff |

**Not implemented:** automatic OTA download orchestration for managed models, CLI, MCP server, local benchmarking, and full native per-capability session execution. The Node SDK has a native runtime bridge smoke path for dynamic loading and capability discovery, but complete local llama.cpp/MLX-style execution still belongs to the Octomil CLI or Python SDK for now.

## Install

```bash
npm install @octomil/sdk
```

```bash
pnpm add @octomil/sdk
```

## Quick Start

### Hosted API (server-side)

Use a server key (secret) for backend / CI / server-side usage. Keep this key out of client bundles.

```bash
export OCTOMIL_SERVER_KEY=YOUR_SERVER_KEY
export OCTOMIL_ORG_ID=YOUR_ORG_ID
```

```typescript
import { Octomil } from "@octomil/sdk";

const client = Octomil.fromEnv();
await client.initialize();
const response = await client.responses.create({
  model: "default",
  input: "What can you help me with?",
});
console.log(response.outputText);
```

### Client-side (browser / mobile)

Use a publishable key for on-device or browser usage. Publishable keys are safe to embed in client bundles.

```typescript
import { Octomil } from "@octomil/sdk";

const client = new Octomil({ publishableKey: "YOUR_CLIENT_KEY" });
await client.initialize();
const response = await client.responses.create({
  model: "default",
  input: "Hello",
});
console.log(response.outputText);
```

### Local runtime injection

When you have a local inference runtime (e.g. ONNX, llama.cpp), inject it directly into `ResponsesClient` to run the Responses API entirely on-device with no server calls:

```typescript
import { ResponsesClient } from "@octomil/sdk";

const client = new ResponsesClient({
  localRuntime: myRuntime,
});
const response = await client.create({
  model: "phi-4-mini",
  input: "Hello",
});
```

### Local CLI (separate Octomil CLI)

This SDK package does not ship a CLI. For direct local inference without a Node.js runtime, install and use the separate Octomil CLI:

```bash
curl -fsSL https://get.octomil.com | sh

octomil run "What can you help me with?"
octomil embed "text to embed" --json
octomil transcribe audio.wav
```

### Migrating from OctomilClient

`OctomilClient` and the low-level `ResponsesClient` / request-object APIs still work exactly as before. The `Octomil` facade is a convenience wrapper for the common path — it delegates to the same underlying client internally.

## Advanced Usage (OctomilClient)

```typescript
import { OctomilClient } from "@octomil/sdk";

const client = new OctomilClient({
  auth: {
    type: "org_api_key",
    apiKey: process.env.OCTOMIL_SERVER_KEY!,
    orgId: process.env.OCTOMIL_ORG_ID!,
  },
});

// Responses API (structured, with tool calls and conversation threading)
const result = await client.responses.create({
  model: "phi-4-mini",
  input: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  instructions: "You are a helpful assistant.",
  maxOutputTokens: 512,
});
console.log(result.output[0].text);

// Streaming
for await (const event of client.responses.stream({
  model: "phi-4-mini",
  input: "Write a haiku about the ocean",
})) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

## Chat API

```typescript
// OpenAI-compatible chat completions
const chat = await client.chat.create({
  model: "phi-4-mini",
  messages: [{ role: "user", content: "Hello" }],
});

// Streaming
for await (const chunk of client.chat.stream({
  model: "phi-4-mini",
  messages: [{ role: "user", content: "Hello" }],
})) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}

// Thread management
const thread = await client.chat.threads.create();
const turn = await client.chat.turn.create(thread.id, { messages: [...] });
```

## Local ONNX Inference

```typescript
// Download and run a model locally
await client.pull("sentiment-v1"); // download + SHA-256 checksum
const prediction = await client.predict("sentiment-v1", inputTensor);
```

## Embeddings

```typescript
// Cloud embeddings via the unified facade
const result = await client.embeddings.create({
  model: "nomic-embed-text-v1.5",
  input: "On-device AI inference at scale",
});
console.log(result.embeddings[0].slice(0, 5));

// Or via the standalone embed() function
import { embed } from "@octomil/sdk";
const result2 = await embed(
  { serverUrl: "https://api.octomil.com", apiKey: process.env.OCTOMIL_SERVER_KEY! },
  "nomic-embed-text",
  ["query", "document"],
);
```

> **Note:** Node embeddings currently use the hosted embeddings endpoint. Use the separate Octomil CLI's `octomil embed` command for local one-shot embeddings.

## Audio Transcription

```typescript
import { readFile } from "node:fs/promises";
import { OctomilClient } from "@octomil/sdk";

const client = new OctomilClient({
  auth: {
    type: "org_api_key",
    apiKey: process.env.OCTOMIL_SERVER_KEY!,
    orgId: process.env.OCTOMIL_ORG_ID!,
  },
});
const audioBuffer = await readFile("meeting.wav");
const transcription = await client.audio.transcriptions.create({
  audio: new Uint8Array(audioBuffer),
  language: "en",
});
console.log(transcription.text);
```

> **Note:** Node audio transcription runs locally when a transcription runtime is registered. Use the separate Octomil CLI's `octomil transcribe` command for local one-shot transcription.

## Streaming

```typescript
// Cloud SSE streaming
for await (const token of client.streamPredict("phi-4-mini", "Explain quantum computing")) {
  process.stdout.write(token.token);
}
```

## Runtime Planner

The runtime planner client fetches server-assisted engine selection plans via the `/api/v2/runtime/plan` endpoint. It determines whether a model should run locally or in the cloud, which engine to use, and which artifact to download.

```typescript
import {
  RuntimePlannerClient,
  collectDeviceRuntimeProfile,
  SUPPORTED_POLICIES,
} from "@octomil/sdk";

// Create a planner client (uses OCTOMIL_SERVER_KEY from env)
const planner = new RuntimePlannerClient({
  apiKey: process.env.OCTOMIL_SERVER_KEY,
});

// Collect device profile automatically
const device = await collectDeviceRuntimeProfile();

// Fetch a runtime plan from the server
const plan = await planner.fetchPlan({
  model: "phi-4-mini",
  capability: "chat",
  routing_policy: "local_first",
  device,
  allow_cloud_fallback: true,
});

if (plan) {
  console.log(`Policy: ${plan.policy}`);
  console.log(`Candidates: ${plan.candidates.length}`);
  for (const c of plan.candidates) {
    console.log(`  ${c.locality} via ${c.engine ?? "cloud"} (confidence: ${c.confidence})`);
  }
}

// Fetch server defaults (supported policies, TTLs)
const defaults = await planner.fetchDefaults();
console.log(`Supported policies: ${defaults?.supported_policies.join(", ")}`);

// Submit benchmark telemetry (best-effort, never throws)
await planner.submitBenchmark({
  source: "planner",
  model: "phi-4-mini",
  capability: "chat",
  engine: "onnxruntime-node",
  device,
  success: true,
  tokens_per_second: 42.5,
});
```

### Supported routing policies

| Policy | Behavior |
|--------|----------|
| `private` / `local_only` | Never contact the cloud |
| `local_first` | Prefer local, fall back to cloud |
| `cloud_first` | Prefer cloud, fall back to local |
| `cloud_only` | Never use local engines |
| `performance_first` | Pick whichever is fastest |

`quality_first` is not a supported policy name.

### Route metadata

Every planner response includes route metadata that can be attached to inference results:

```typescript
import type { RouteMetadata } from "@octomil/sdk";

const metadata: RouteMetadata = {
  locality: "on_device",
  engine: "onnxruntime-node",
  planner_source: "server",
  fallback_used: false,
  reason: "local engine available and model format supported",
};
```

> **Note:** The Node SDK currently supports server-assisted planning plus a native runtime bridge smoke path for dynamic loading and capability discovery. It does not yet provide complete local session execution for every native capability. For full local execution, use the Octomil CLI or Python SDK.

## AppManifest (Capability-Driven)

```typescript
import { ModelCapability, DeliveryMode } from "@octomil/sdk";

client.bootstrapManifest({
  models: [
    {
      id: "chat-model",
      capability: ModelCapability.Chat,
      delivery: DeliveryMode.Managed,
    },
    {
      id: "classifier",
      capability: ModelCapability.Classification,
      delivery: DeliveryMode.Bundled,
      bundledPath: "./models/classifier.onnx",
    },
  ],
});
```

## Control Plane

```typescript
// Device registration + heartbeat
await client.control.register();
client.control.startHeartbeat(300_000); // 5 min interval, unref'd

// Desired state sync
const state = await client.control.fetchDesiredState();
await client.control.sync({ modelInventory: [...] });
await client.control.reportObservedState(models);

// No automatic polling — intentional for server-side SDK
```

## Silent Registration (for device-like Node apps)

```typescript
import { configure } from "@octomil/sdk";

configure({
  auth: { type: "publishable_key", key: "oct_pub_live_..." },
  monitoring: { enabled: true },
});
// Background registration with exponential backoff (10 retries, max 5 min)
// Heartbeat timer (unref'd so it doesn't block process exit)
```

## Native Runtime (dev path)

The Node SDK can load the native `liboctomil-runtime` dylib for local
inference. A fetch script populates the cache that the SDK loader reads
automatically.

### Fetch the dylib

```bash
pnpm fetch:runtime
# or equivalently:
node scripts/fetch_runtime_dev.mjs
```

Options:

```
--version <tag>      Release tag to fetch (default: v0.1.16)
--cache-root <path>  Override cache root
--force              Re-download even if cache is already populated
```

### Cache layout

```
~/.cache/octomil-runtime/
  <version>/
    lib/
      liboctomil-runtime.dylib   # loaded by the SDK
      .extracted-ok              # sentinel — loader requires this to trust the cache
    include/
      octomil.h                  # C headers (for native consumers)
```

### Environment variables

| Variable | Effect |
|----------|--------|
| `OCTOMIL_RUNTIME_CACHE_DIR` | Override the cache root (default: `~/.cache/octomil-runtime`) |
| `OCTOMIL_RUNTIME_DYLIB` | Point directly at a specific dylib; bypasses cache lookup entirely |

### Token resolution

The fetch script needs a GitHub token with read access to the private
`octomil/octomil-runtime` repo. Resolution order:

1. `$GH_TOKEN`
2. `$GITHUB_TOKEN`
3. `$OCTOMIL_RUNTIME_TOKEN`
4. `gh auth token` (via the GitHub CLI — run `gh auth login` first)

### Why `_dev`?

This script downloads unsigned development binaries from the private
`octomil/octomil-runtime` GitHub release. It is intended for local
development and CI only. Production / customer distribution will use
signed-and-notarized binaries via a separate delivery path; this script
covers the v0.0.x dev range only.

## Development

```bash
pnpm install
pnpm test          # run tests
pnpm build         # build ESM + CJS
pnpm typecheck     # type check
pnpm lint          # lint
pnpm format        # format
```

## Releasing

Releases publish to npm from GitHub Releases via trusted publishing with npm provenance. Before cutting the first release, configure npm trusted publishing for `@octomil/sdk` with repository `octomil/octomil-node` and workflow `.github/workflows/publish.yml`.

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run exports:check
pnpm run pack:check
```

Then create a GitHub Release for the package version in `package.json`. The publish workflow runs the same gates and publishes `@octomil/sdk` with public scoped-package access and provenance.

## Requirements

- Node.js 18+
- ONNX Runtime Node (`onnxruntime-node ^1.17.0`)

## License

[MIT](LICENSE)
