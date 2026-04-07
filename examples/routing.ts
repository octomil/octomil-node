/**
 * Example: managed deployment routing with OctomilClient.
 *
 * When a deploymentId is provided, the SDK omits `prefer` from
 * route requests so the server applies the deployment's routing policy.
 */
import { OctomilClient, configure } from "octomil";

// Configure with deployment context
configure({
  apiKey: "edg_your_key",
  orgId: "org_your_org",
  serverUrl: "https://api.octomil.com",
});

// Option A: Managed deployment routing (recommended)
// The server applies the deployment's routing_preference automatically.
const managedClient = new OctomilClient({
  model: "chat-model",
  deploymentId: "dep_abc123",
  // Do NOT set `prefer` — let the server decide based on deployment policy
});

const decision = await managedClient.route({
  modelParams: 3_000_000_000,
  modelSizeMb: 1500,
  deviceCapabilities: {
    platform: "ios",
    model: "iPhone17,1",
    totalMemoryMb: 8192,
    npuAvailable: true,
  },
});
console.log(`Routed to: ${decision.target}`);

// Option B: Explicit preference override
// When you need to override the deployment's policy for a specific request.
const overrideClient = new OctomilClient({
  model: "chat-model",
  deploymentId: "dep_abc123",
  prefer: "device", // Overrides deployment policy — forces on-device routing
});
