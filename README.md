# @octomil/sdk (Node.js)

> **Status: Work in Progress (v0.1.0)** — not yet published to npm.

Node.js SDK for downloading, caching, and running ONNX models locally via ONNX Runtime.

## What works today

- **ONNX inference** — load and run ONNX models via `onnxruntime-node`
- **Model download & cache** — pull models with checksum verification and local file cache
- **Streaming inference** — SSE token streaming
- **Query routing** — route between on-device and cloud inference
- **Embeddings** — cloud embeddings endpoint
- **Telemetry** — usage reporting
- **File integrity** — SHA-256 hash verification

## What's missing (vs production SDKs)

- Chat completions (OpenAI-compatible API)
- Model catalog / resolver (60+ model registry)
- Federated learning
- A/B testing / experiments
- Rollouts / canary deployments
- Privacy / secure aggregation
- Benchmarking
- CLI
- MCP server

See the [Python SDK](https://github.com/octomil/octomil-python) for the full-featured CLI + inference experience, or the [Browser SDK](https://github.com/octomil/octomil-browser) for browser-based inference with federated learning.

## Install

```bash
# not yet published — install from source
pnpm install
pnpm build
```

## Usage

```typescript
import { OctomilClient } from "@octomil/sdk";

const client = new OctomilClient({
  apiKey: "oct_...",
  orgId: "org_123",
});

// Download and run a model
const model = await client.pull("sentiment-v1");
const result = await model.predict(inputTensor);
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
