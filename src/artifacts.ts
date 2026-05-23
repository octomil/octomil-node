import { ServerApiClient, type ServerClientOptions } from "./server-api.js";
import type { components } from "./generated/types.js";

export interface ArtifactDownloadUrlsRequest {
  files?: Array<{
    path: string;
    chunkIndices?: number[];
  }>;
  expiresInSeconds?: number;
}

export type ArtifactManifest = components["schemas"]["artifact_manifest"];
// TODO: bind to generated when schema is tightened — the download-urls endpoint
// returns an inline response type with no named schema in the current contract.
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
