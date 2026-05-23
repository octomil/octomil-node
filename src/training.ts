import { OctomilError, ErrorCode} from "./types.js";
import {
  ServerApiClient,
  type ServerClientOptions,
} from "./server-api.js";
import type { components } from "./generated/types.js";

// Mirror the monitoring.ts pattern: public names stay stable, definitions
// derive from openapi-typescript so drift becomes a compile error.
export type TrainingJob = components["schemas"]["Job"];
// Job is the server's canonical training-job record; all three training-job
// endpoints (create / status / complete) return the same Job shape.
export type TrainingJobStatus = components["schemas"]["Job"];

export interface TrainingClientOptions extends ServerClientOptions {
  getDeviceId: () => string | null;
}

export class TrainingClient extends ServerApiClient {
  private readonly getDeviceId: () => string | null;

  constructor(options: TrainingClientOptions) {
    super(options);
    this.getDeviceId = options.getDeviceId;
  }

  async createJob(request: Record<string, unknown>): Promise<TrainingJob> {
    return this.requestJson<TrainingJob>(
      `/api/v1/devices/${encodeURIComponent(this.requireDeviceId())}/training-jobs`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  async jobStatus(
    jobId: string,
    request: Record<string, unknown>,
  ): Promise<TrainingJobStatus> {
    return this.requestJson<TrainingJobStatus>(
      `/api/v1/devices/${encodeURIComponent(this.requireDeviceId())}/training-jobs/${encodeURIComponent(jobId)}/status`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }

  async jobComplete(
    jobId: string,
    request: Record<string, unknown>,
  ): Promise<TrainingJobStatus> {
    return this.requestJson<TrainingJobStatus>(
      `/api/v1/devices/${encodeURIComponent(this.requireDeviceId())}/training-jobs/${encodeURIComponent(jobId)}/complete`,
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
        ErrorCode.DeviceNotRegistered,
        "This operation requires a registered device ID.",
      );
    }
    return deviceId;
  }
}
