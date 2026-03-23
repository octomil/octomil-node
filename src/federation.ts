import { OctomilError } from "./types.js";
import {
  ServerApiClient,
  type ServerClientOptions,
} from "./server-api.js";

export interface FederationClientOptions extends ServerClientOptions {
  getDeviceId: () => string | null;
}

export class FederationClient extends ServerApiClient {
  private readonly getDeviceId: () => string | null;

  constructor(options: FederationClientOptions) {
    super(options);
    this.getDeviceId = options.getDeviceId;
  }

  async offers(): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      "/api/v1/federation/rounds/offers",
      { method: "GET" },
      { deviceId: this.requireDeviceId() },
    );
  }

  async join(
    roundId: string,
    request: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/federation/rounds/${encodeURIComponent(roundId)}/join`,
      {
        method: "POST",
        body: JSON.stringify({
          deviceId: this.requireDeviceId(),
          ...request,
        }),
      },
    );
  }

  async plan(planId: string): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/federation/plans/${encodeURIComponent(planId)}`,
      { method: "GET" },
    );
  }

  async heartbeat(
    roundId: string,
    request: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/federation/rounds/${encodeURIComponent(roundId)}/heartbeat`,
      {
        method: "POST",
        body: JSON.stringify({
          deviceId: this.requireDeviceId(),
          ...request,
        }),
      },
    );
  }

  async uploadInitiate(
    roundId: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/federation/rounds/${encodeURIComponent(roundId)}/updates/initiate`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  async uploadComplete(
    roundId: string,
    uploadId: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.requestJson<Record<string, unknown>>(
      `/api/v1/federation/rounds/${encodeURIComponent(roundId)}/updates/${encodeURIComponent(uploadId)}/complete`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  private requireDeviceId(): string {
    const deviceId = this.getDeviceId();
    if (!deviceId) {
      throw new OctomilError(
        "DEVICE_NOT_REGISTERED",
        "This operation requires a registered device ID.",
      );
    }
    return deviceId;
  }
}
