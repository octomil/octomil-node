/**
 * DeviceContext — tracks installation identity, registration state, and auth tokens
 * for the device registration flow.
 *
 * Uses crypto.randomUUID() for installation IDs and persists to filesystem.
 * Registration state is NOT persisted to disk.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { OTLP_RESOURCE_ATTRIBUTES } from "./_generated/otlp_resource_attributes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RegistrationState = "pending" | "registered" | "failed";

export type TokenState =
  | { type: "none" }
  | { type: "valid"; accessToken: string; expiresAt: Date }
  | { type: "expired" };

// ---------------------------------------------------------------------------
// DeviceContext
// ---------------------------------------------------------------------------

export class DeviceContext {
  readonly installationId: string;
  readonly orgId: string | null;
  readonly appId: string | null;

  private _registrationState: RegistrationState = "pending";
  private _tokenState: TokenState = { type: "none" };
  private _serverDeviceId: string | null = null;

  constructor(opts: {
    installationId: string;
    orgId?: string | null;
    appId?: string | null;
  }) {
    this.installationId = opts.installationId;
    this.orgId = opts.orgId ?? null;
    this.appId = opts.appId ?? null;
  }

  get registrationState(): RegistrationState {
    return this._registrationState;
  }

  get tokenState(): TokenState {
    return this._tokenState;
  }

  get serverDeviceId(): string | null {
    return this._serverDeviceId;
  }

  get isRegistered(): boolean {
    return this._registrationState === "registered";
  }

  authHeaders(): Record<string, string> | null {
    if (this._tokenState.type === "valid") {
      if (this._tokenState.expiresAt > new Date()) {
        return { Authorization: `Bearer ${this._tokenState.accessToken}` };
      }
    }
    return null;
  }

  telemetryResource(): Record<string, string> {
    const resource: Record<string, string> = {
      "device.id": this.installationId,
      [OTLP_RESOURCE_ATTRIBUTES.octomilInstallId]: this.installationId,
      platform: "node",
    };
    if (this.orgId) resource["org.id"] = this.orgId;
    if (this.appId) resource["app.id"] = this.appId;
    return resource;
  }

  /** @internal */
  _updateRegistered(
    serverDeviceId: string,
    accessToken: string,
    expiresAt: Date,
  ): void {
    this._serverDeviceId = serverDeviceId;
    this._tokenState = { type: "valid", accessToken, expiresAt };
    this._registrationState = "registered";
  }

  /** @internal */
  _updateToken(accessToken: string, expiresAt: Date): void {
    this._tokenState = { type: "valid", accessToken, expiresAt };
  }

  /** @internal */
  _markFailed(): void {
    this._registrationState = "failed";
  }

  /** @internal */
  _markTokenExpired(): void {
    this._tokenState = { type: "expired" };
  }

  // -----------------------------------------------------------------------
  // Installation ID persistence
  // -----------------------------------------------------------------------

  private static readonly STORAGE_DIR = join(homedir(), ".octomil");
  private static readonly STORAGE_FILE = join(
    DeviceContext.STORAGE_DIR,
    "installation_id",
  );

  static getOrCreateInstallationId(): string {
    try {
      if (existsSync(DeviceContext.STORAGE_FILE)) {
        const existing = readFileSync(DeviceContext.STORAGE_FILE, "utf-8").trim();
        if (existing) return existing;
      }
    } catch {
      // Read failed — generate new
    }

    const newId = randomUUID();
    try {
      mkdirSync(DeviceContext.STORAGE_DIR, { recursive: true });
      writeFileSync(DeviceContext.STORAGE_FILE, newId, "utf-8");
    } catch {
      // Write failed — use ephemeral ID
    }
    return newId;
  }
}
