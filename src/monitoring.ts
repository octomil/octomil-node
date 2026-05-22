import { ServerApiClient, type ServerClientOptions } from "./server-api.js";
import type { components } from "./generated/types.js";

// Pilot use of OSS-generated transport types.
//
// Public AlertRule / UpdateAlertRuleRequest names stay stable for SDK
// consumers — but their definitions now come from openapi-typescript,
// which derives them from octomil-contracts/dist/openapi.yaml. Drift
// between facade and contract becomes a compile error rather than a
// runtime 4xx.
//
// Pattern to replicate across the rest of the SDK in follow-up PRs:
//   1. Import `components` from src/generated/types.js
//   2. Re-export the public name as an alias of the generated schema
//   3. Keep the facade method signatures unchanged
export type AlertRule = components["schemas"]["AlertRuleResponse"];
export type UpdateAlertRuleRequest = components["schemas"]["UpdateAlertRuleRequest"];

export class MonitoringClient extends ServerApiClient {
  constructor(options: ServerClientOptions) {
    super(options);
  }

  async getAlertRule(
    ruleId: string,
    orgId?: string,
  ): Promise<AlertRule> {
    return this.requestJson<AlertRule>(
      `/api/v1/monitoring/alerts/${encodeURIComponent(ruleId)}`,
      { method: "GET" },
      { org_id: orgId ?? this.orgId },
    );
  }

  async updateAlertRule(
    ruleId: string,
    request: UpdateAlertRuleRequest,
    orgId?: string,
  ): Promise<AlertRule> {
    return this.requestJson<AlertRule>(
      `/api/v1/monitoring/alerts/${encodeURIComponent(ruleId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(request),
      },
      { org_id: orgId ?? this.orgId },
    );
  }

  async deleteAlertRule(ruleId: string, orgId?: string): Promise<void> {
    await this.requestVoid(
      `/api/v1/monitoring/alerts/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
      { org_id: orgId ?? this.orgId },
    );
  }
}
