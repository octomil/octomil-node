import { ServerApiClient, type ServerClientOptions } from "./server-api.js";

export interface ArtifactDownloadUrlsRequest {
  files?: Array<{
    path: string;
    chunkIndices?: number[];
  }>;
  expiresInSeconds?: number;
}

export type ArtifactManifest = Record<string, unknown>;
export type ArtifactDownloadUrls = Record<string, unknown>;

export class ArtifactsClient extends ServerApiClient {
  constructor(options: ServerClientOptions) {
    super(options);
  }

  async manifest(artifactId: string): Promise<ArtifactManifest> {
    return this.requestJson<ArtifactManifest>(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/manifest`,
      { method: "GET" },
    );
  }

  async downloadUrls(
    artifactId: string,
    request: ArtifactDownloadUrlsRequest,
  ): Promise<ArtifactDownloadUrls> {
    return this.requestJson<ArtifactDownloadUrls>(
      `/api/v1/artifacts/${encodeURIComponent(artifactId)}/download-urls`,
      {
        method: "POST",
        body: JSON.stringify(request),
      },
    );
  }
}
