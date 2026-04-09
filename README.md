# @octomil/sdk (Node.js)

> **Status:** v0.1.0 — feature-complete but not yet published to npm. Install from source.

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
| Device capabilities | Implemented — RAM-based device class, accelerator detection |
| Telemetry | Implemented — OTLP batched reporter |
| Tool runner | Implemented — automated multi-turn tool call loop |
| configure() (silent registration) | Implemented — background registration with backoff |

**Not implemented:** npm publishing, automatic OTA download orchestration for managed models, CLI, MCP server, benchmarking.

## Install

```bash
# not yet published — install from source
pnpm install
pnpm build
```

## Quick Start (Unified Facade)

```typescript
import { Octomil } from "@octomil/sdk";

const client = new Octomil({ apiKey: "edg_...", orgId: "org_..." });
await client.initialize();
const response = await client.responses.create({
  model: "phi-4-mini",
  input: "Hello",
});
console.log(response.outputText);

// Embeddings
const result = await client.embeddings.create({
  model: "nomic-embed-text-v1.5",
  input: "On-device AI inference at scale",
});
console.log(result.embeddings[0].slice(0, 5));
```

### Migrating from OctomilClient

`OctomilClient` and the low-level `ResponsesClient` / request-object APIs still work exactly as before. The `Octomil` facade is a convenience wrapper for the common path — it delegates to the same underlying client internally.

## Advanced Usage (OctomilClient)

```typescript
import { OctomilClient } from "@octomil/sdk";

const client = new OctomilClient({
  auth: { type: "org_api_key", apiKey: "edg_...", orgId: "org_123" },
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

## Embeddings and Streaming

```typescript
// Cloud embeddings
const embeddings = await client.embed("nomic-embed-text", ["query", "document"]);

// Cloud SSE streaming
for await (const token of client.streamPredict("phi-4-mini", "Explain quantum computing")) {
  process.stdout.write(token.token);
}
```

## Development

```bash
pnpm install
pnpm test          # run tests
pnpm build         # build ESM + CJS
pnpm typecheck     # type check
pnpm lint          # lint
pnpm format        # format
```

## Requirements

- Node.js 18+
- ONNX Runtime Node (`onnxruntime-node ^1.17.0`)

## License

[MIT](LICENSE)
