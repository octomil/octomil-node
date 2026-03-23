import { ServerApiClient, type ServerClientOptions } from "./server-api.js";

export type BillingSession = Record<string, unknown>;
export type BillingState = Record<string, unknown>;
export type UsageLimits = Record<string, unknown>;
export type Integration = Record<string, unknown>;
export type IntegrationValidation = Record<string, unknown>;
export type IntegrationPatch = Record<string, unknown>;

export class SettingsClient extends ServerApiClient {
  constructor(options: ServerClientOptions) {
    super(options);
  }

  async createCheckoutSession(
    request: Record<string, unknown>,
    orgId?: string,
  ): Promise<BillingSession> {
    return this.requestJson<BillingSession>(
      "/api/v1/settings/billing/checkout",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async createPortalSession(
    request: Record<string, unknown>,
    orgId?: string,
  ): Promise<BillingSession> {
    return this.requestJson<BillingSession>(
      "/api/v1/settings/billing/portal",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateBilling(
    request: Record<string, unknown>,
    orgId?: string,
  ): Promise<BillingState> {
    return this.requestJson<BillingState>(
      "/api/v1/settings/billing",
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async getUsageLimits(orgId?: string): Promise<UsageLimits> {
    return this.requestJson<UsageLimits>(
      "/api/v1/settings/usage-limits",
      { method: "GET" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateUsageLimits(
    request: Record<string, unknown>,
    orgId?: string,
  ): Promise<UsageLimits> {
    return this.requestJson<UsageLimits>(
      "/api/v1/settings/usage-limits",
      {
        method: "PUT",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async getIntegration(
    integrationId: string,
    orgId?: string,
  ): Promise<Integration> {
    return this.requestJson<Integration>(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}`,
      { method: "GET" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateIntegration(
    integrationId: string,
    request: IntegrationPatch,
    orgId?: string,
  ): Promise<Integration> {
    return this.requestJson<Integration>(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async deleteIntegration(
    integrationId: string,
    orgId?: string,
  ): Promise<void> {
    await this.requestVoid(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}`,
      { method: "DELETE" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async validateIntegration(
    integrationId: string,
    orgId?: string,
  ): Promise<IntegrationValidation> {
    return this.requestJson<IntegrationValidation>(
      `/api/v1/settings/integrations/${encodeURIComponent(integrationId)}/validate`,
      { method: "POST", body: JSON.stringify({}) },
      { org_id: orgId ?? this.orgId },
    );
  }
}
