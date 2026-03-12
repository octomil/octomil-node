import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import type { PullResult } from "./types.js";
import { OctomilError } from "./types.js";

export class ModelDownloader {
  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly orgId: string,
  ) {}

  async resolve(modelRef: string, version?: string, format?: string): Promise<PullResult> {
    const [name, tag = "latest"] = modelRef.split(":");
    const url = `${this.serverUrl}/api/v1/registry/pull`;
    const body = JSON.stringify({
      name,
      tag: version ?? tag,
      format: format ?? "onnx",
      org_id: this.orgId,
    });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new OctomilError(
        `Registry resolve failed (${resp.status}): ${text}`,
        "MODEL_NOT_FOUND",
      );
    }

    const data = (await resp.json()) as Record<string, unknown>;
    return {
      name: (data.name as string) ?? name!,
      tag: (data.tag as string) ?? tag,
      downloadUrl: data.download_url as string,
      format: (data.format as string) ?? "onnx",
      sizeBytes: (data.size_bytes as number) ?? 0,
      checksum: data.checksum as string | undefined,
    };
  }

  async download(
    url: string,
    destPath: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });

    const resp = await fetch(url);
    if (!resp.ok || !resp.body) {
      throw new OctomilError(
        `Download failed (${resp.status})`,
        "NETWORK_UNAVAILABLE",
      );
    }

    const total = Number(resp.headers.get("content-length") ?? 0);
    let downloaded = 0;

    const reader = resp.body;
    const nodeStream = Readable.fromWeb(reader as any);

    const transform = new Transform({
      transform(chunk, _encoding, callback) {
        downloaded += chunk.length;
        onProgress?.(downloaded, total);
        callback(null, chunk);
      },
    });

    await pipeline(nodeStream, transform, createWriteStream(destPath));
  }
}
