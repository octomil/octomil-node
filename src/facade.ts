/**
 * Unified Octomil facade — single-constructor entry point for the SDK.
 *
 * Supports three auth paths:
 *   1. publishableKey  — client-side / on-device usage
 *   2. apiKey + orgId  — server-side / CI usage
 *   3. auth            — advanced pass-through of AuthConfig
 */

import { ResponsesClient } from "./responses.js";
import type {
  ResponseRequest,
  ResponseObj,
  ResponseOutput,
  ResponseStreamEvent,
} from "./responses.js";
import { validatePublishableKey } from "./auth-config.js";
import { configure } from "./configure.js";
import type { AuthConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OctomilNotInitializedError extends Error {
  constructor() {
    super(
      "Octomil client is not initialized. Call await client.initialize() first.",
    );
    this.name = "OctomilNotInitializedError";
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OctomilFacadeOptions {
  publishableKey?: string;
  apiKey?: string;
  orgId?: string;
  auth?: AuthConfig;
  serverUrl?: string;
  telemetry?: boolean;
}

// ---------------------------------------------------------------------------
// FacadeResponses
// ---------------------------------------------------------------------------

/** Convenience wrapper around ResponsesClient that adds `outputText`. */
class FacadeResponses {
  constructor(private readonly client: ResponsesClient) {}

  async create(
    request: ResponseRequest,
  ): Promise<ResponseObj & { outputText: string }> {
    const response = await this.client.create(request);
    return Object.assign(response, {
      get outputText(): string {
        return extractOutputText(response.output);
      },
    });
  }

  async *stream(
    request: ResponseRequest,
  ): AsyncGenerator<ResponseStreamEvent> {
    yield* this.client.stream(request);
  }
}

// ---------------------------------------------------------------------------
// Octomil facade
// ---------------------------------------------------------------------------

export class Octomil {
  private initialized = false;
  private readonly responsesClient: ResponsesClient;
  private readonly options: OctomilFacadeOptions;
  private _responses: FacadeResponses | undefined;

  constructor(options: OctomilFacadeOptions) {
    this.options = options;

    // Validate publishable key eagerly so constructor throws on bad prefix.
    if (options.publishableKey) {
      validatePublishableKey(options.publishableKey);
    }

    // Build a ResponsesClient from the resolved auth credentials.
    const serverUrl = options.serverUrl ?? "https://api.octomil.com";

    let apiKey: string | undefined;
    if (options.publishableKey) {
      apiKey = options.publishableKey;
    } else if (options.apiKey) {
      apiKey = options.apiKey;
    } else if (options.auth) {
      apiKey =
        options.auth.type === "org_api_key"
          ? options.auth.apiKey
          : options.auth.bootstrapToken;
    }

    this.responsesClient = new ResponsesClient({
      serverUrl,
      apiKey,
    });
  }

  /**
   * Initialize the client. Must be called (and awaited) before using
   * `responses`. Idempotent — subsequent calls are no-ops.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Validate that at least one auth method was provided.
    if (
      !this.options.publishableKey &&
      !this.options.apiKey &&
      !this.options.auth
    ) {
      throw new Error(
        "Octomil requires one of: publishableKey, apiKey + orgId, or auth",
      );
    }

    if (this.options.apiKey && !this.options.orgId && !this.options.auth) {
      throw new Error("orgId is required when using apiKey");
    }

    // For publishable key path, trigger device registration (fire-and-forget).
    if (this.options.publishableKey) {
      configure({
        auth: { type: "publishable_key", key: this.options.publishableKey },
        baseUrl: this.options.serverUrl,
      }).catch(() => {});
    }

    this.initialized = true;
  }

  /**
   * Responses namespace. Throws OctomilNotInitializedError if `initialize()`
   * has not been called.
   */
  get responses(): FacadeResponses {
    if (!this.initialized) {
      throw new OctomilNotInitializedError();
    }
    if (!this._responses) {
      this._responses = new FacadeResponses(this.responsesClient);
    }
    return this._responses;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractOutputText(output: ResponseOutput[]): string {
  return output
    .filter((o) => o.type === "text")
    .map((o) => o.text ?? "")
    .join("");
}
