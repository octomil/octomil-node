import type { OctomilClientOptions } from "./types.js";
import { OctomilError } from "./types.js";

export interface MetricsIntegration {
  id: string;
  org_id: string;
  name: string;
  integration_type: string;
  enabled: boolean;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  last_export_at?: string;
}

export interface LogIntegration {
  id: string;
  org_id: string;
  name: string;
  integration_type: string;
  endpoint_url: string;
  format: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateMetricsIntegrationInput {
  name: string;
  integration_type: "prometheus" | "opentelemetry" | "datadog" | "statsd";
  config: Record<string, unknown>;
  enabled?: boolean;
}

export interface CreateLogIntegrationInput {
  name: string;
  integration_type: string;
  endpoint_url: string;
  format?: string;
  auth_config?: Record<string, unknown>;
}

export interface CreateOtlpCollectorInput {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
}

export class IntegrationsClient {
  private readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly orgId: string;

  constructor(serverUrl: string, apiKey: string, orgId: string) {
    this.serverUrl = serverUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.orgId = orgId;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.serverUrl}/api/v1${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new OctomilError("NETWORK_UNAVAILABLE", `Request failed (${resp.status}): ${text}`);
    }
    if (resp.status === 204 || resp.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return resp.json() as Promise<T>;
  }

  // --- Metrics integrations ---

  async listMetricsIntegrations(): Promise<MetricsIntegration[]> {
    return this.request("GET", `/metrics/integrations?org_id=${this.orgId}`);
  }

  async createMetricsIntegration(input: CreateMetricsIntegrationInput): Promise<MetricsIntegration> {
    return this.request("POST", `/metrics/integrations?org_id=${this.orgId}`, input);
  }

  async deleteMetricsIntegration(integrationId: string): Promise<void> {
    return this.request("DELETE", `/metrics/integrations/${integrationId}`);
  }

  async testMetricsIntegration(integrationId: string): Promise<unknown> {
    return this.request("POST", `/metrics/integrations/${integrationId}/test`, {});
  }

  // --- Log integrations ---

  async listLogIntegrations(): Promise<LogIntegration[]> {
    return this.request("GET", "/log-streams/integrations");
  }

  async createLogIntegration(input: CreateLogIntegrationInput): Promise<LogIntegration> {
    return this.request("POST", "/log-streams/integrations", input);
  }

  async deleteLogIntegration(integrationId: string): Promise<void> {
    return this.request("DELETE", `/log-streams/integrations/${integrationId}`);
  }

  async testLogIntegration(integrationId: string): Promise<{ success: boolean; message: string }> {
    return this.request("POST", `/log-streams/integrations/${integrationId}/test`, {});
  }

  // --- Unified OTLP shortcut ---

  async connectOtlpCollector(input: CreateOtlpCollectorInput): Promise<{
    metrics: MetricsIntegration;
    logs: LogIntegration;
  }> {
    const baseEndpoint = input.endpoint.replace(/\/+$/, "");

    const metrics = await this.createMetricsIntegration({
      name: `${input.name} (metrics)`,
      integration_type: "opentelemetry",
      config: {
        endpoint: baseEndpoint,
        ...(input.headers ? { headers: input.headers } : {}),
      },
      enabled: true,
    });

    const authConfig: Record<string, unknown> = {};
    if (input.headers) {
      authConfig.type = "headers";
      authConfig.headers = input.headers;
    }

    const logs = await this.createLogIntegration({
      name: `${input.name} (logs)`,
      integration_type: "otlp",
      endpoint_url: `${baseEndpoint}/v1/logs`,
      format: "otlp",
      ...(Object.keys(authConfig).length > 0 ? { auth_config: authConfig } : {}),
    });

    return { metrics, logs };
  }
}
