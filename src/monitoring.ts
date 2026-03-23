import { ServerApiClient, type ServerClientOptions } from "./server-api.js";

export type AlertRule = Record<string, unknown>;
export type UpdateAlertRuleRequest = Record<string, unknown>;

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
