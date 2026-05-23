import { ServerApiClient, type ServerClientOptions } from "./server-api.js";
import type { components } from "./generated/types.js";

// createCheckoutSession -> CheckoutResponse; createPortalSession -> PortalResponse.
// The old BillingSession alias covered both with Record<string, unknown>; we now
// split into the concrete generated shapes. Public method names are unchanged.
export type BillingSession = components["schemas"]["CheckoutResponse"] | components["schemas"]["PortalResponse"];
// TODO: bind to generated when schema is tightened — settings_billing_update
// returns Record<string, never> (empty object) in the contract; widening to
// BillingState = Record<string, unknown> is safe for consumers, narrowing
// would break them. Leave until the contract exposes a named type.
export type BillingState = Record<string, unknown>;
export type UsageLimits = components["schemas"]["UsageLimitsResponse"];
export type Integration = components["schemas"]["IntegrationDetailResponse"];
export type IntegrationValidation = components["schemas"]["IntegrationTestResponse"];
export type IntegrationPatch = components["schemas"]["UpdateIntegrationRequest"];

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
