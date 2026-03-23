import type {
  ControlClient,
  DesiredState,
  DeviceSyncRequest,
  DeviceSyncResponse,
  ObservedModelStatus,
} from "./control.js";

export class DevicesClient {
  constructor(private readonly control: ControlClient) {}

  async desiredState(): Promise<DesiredState> {
    return this.control.fetchDesiredState();
  }

  async observedState(models: ObservedModelStatus[] = []): Promise<void> {
    await this.control.reportObservedState(models);
  }

  async sync(request: {
    knownStateVersion?: string;
    sdkVersion?: string;
    appId?: string;
    appVersion?: string;
    modelInventory?: DeviceSyncRequest["modelInventory"];
    activeVersions?: DeviceSyncRequest["activeVersions"];
    availableStorageBytes?: number;
  } = {}): Promise<DeviceSyncResponse> {
    return this.control.sync(request);
  }
}
