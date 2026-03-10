import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CacheEntry, CacheInfo } from "./types.js";

interface CacheManifest {
  entries: CacheEntry[];
}

export class FileCache {
  private readonly manifestPath: string;

  constructor(private readonly cacheDir: string) {
    this.manifestPath = join(cacheDir, "manifest.json");
  }

  private readManifest(): CacheManifest {
    if (!existsSync(this.manifestPath)) {
      return { entries: [] };
    }
    try {
      const raw = readFileSync(this.manifestPath, "utf-8");
      return JSON.parse(raw) as CacheManifest;
    } catch {
      return { entries: [] };
    }
  }

  private writeManifest(manifest: CacheManifest): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  has(modelRef: string, checksum?: string): boolean {
    const manifest = this.readManifest();
    const entry = manifest.entries.find((e) => e.modelRef === modelRef);
    if (!entry) return false;
    if (!existsSync(entry.filePath)) return false;
    if (checksum && entry.checksum !== checksum) return false;
    return true;
  }

  getPath(modelRef: string): string | null {
    const manifest = this.readManifest();
    const entry = manifest.entries.find((e) => e.modelRef === modelRef);
    if (!entry || !existsSync(entry.filePath)) return null;
    return entry.filePath;
  }

  register(entry: CacheEntry): void {
    const manifest = this.readManifest();
    const idx = manifest.entries.findIndex((e) => e.modelRef === entry.modelRef);
    if (idx >= 0) {
      manifest.entries[idx] = entry;
    } else {
      manifest.entries.push(entry);
    }
    this.writeManifest(manifest);
  }

  remove(modelRef: string): void {
    const manifest = this.readManifest();
    const entry = manifest.entries.find((e) => e.modelRef === modelRef);
    if (entry && existsSync(entry.filePath)) {
      try {
        rmSync(entry.filePath);
      } catch {
        // best-effort
      }
    }
    manifest.entries = manifest.entries.filter((e) => e.modelRef !== modelRef);
    this.writeManifest(manifest);
  }

  list(): CacheInfo[] {
    const manifest = this.readManifest();
    return manifest.entries
      .filter((e) => existsSync(e.filePath))
      .map((e) => ({
        modelRef: e.modelRef,
        filePath: e.filePath,
        cachedAt: e.cachedAt,
        sizeBytes: e.sizeBytes,
      }));
  }
}
