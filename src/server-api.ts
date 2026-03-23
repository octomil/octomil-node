import { OctomilError } from "./types.js";

export interface ServerClientOptions {
  serverUrl: string;
  apiKey: string;
  orgId?: string;
}

export type QueryValue = string | number | boolean | null | undefined;

export class ServerApiClient {
  protected readonly serverUrl: string;
  protected readonly apiKey: string;
  protected readonly orgId: string | undefined;

  constructor(options: ServerClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.orgId = options.orgId;
  }

  protected buildUrl(
    path: string,
    query?: Record<string, QueryValue>,
  ): string {
    const url = new URL(path, `${this.serverUrl}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  protected async requestJson<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    const response = await this.request(path, init, query);
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  protected async requestVoid(
    path: string,
    init: RequestInit = {},
    query?: Record<string, QueryValue>,
  ): Promise<void> {
    await this.request(path, init, query);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    query?: Record<string, QueryValue>,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Content-Type") && init.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.apiKey}`);
    }

    let response: Response;
    try {
      response = await fetch(this.buildUrl(path, query), {
        ...init,
        headers,
      });
    } catch (error) {
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Request failed: ${String(error)}`,
        error,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new OctomilError(
        "NETWORK_UNAVAILABLE",
        `Request failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`,
      );
    }

    return response;
  }
}
