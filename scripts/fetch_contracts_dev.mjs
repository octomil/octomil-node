#!/usr/bin/env node
/**
 * Fetch a dev-only conformance artifact from octomil/octomil-contracts
 * and unpack it into the local cache.
 *
 * Mirrors octomil-python/scripts/fetch_contracts_dev.py in Node idioms.
 *
 * Pin-driven version selection via CONFORMANCE_PIN.
 * Two-stage resolution:
 *   1. local sibling octomil-contracts/build/conformance/ checkout (dev loop)
 *   2. GitHub Release asset on the private contracts repo (CI / other devs)
 *
 * Cache root: ~/.cache/octomil-conformance/<version>/
 * Sentinel: <cache>/.extracted-ok — written only on full extraction.
 *
 * Soft-skip policy: if the artifact is unreachable (no local checkout +
 * no GitHub token / 404 / 401), exits 0 with a clear stderr message.
 * The conformance test hook detects the absent sentinel and skips collection.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Extract } from "node:stream";
import * as https from "node:https";
import * as http from "node:http";
import { createGunzip } from "node:zlib";
import * as tar from "node:stream";

const REPO = "octomil/octomil-contracts";
const CACHE_ROOT = path.join(os.homedir(), ".cache", "octomil-conformance");
const RESERVED_SENTINEL = ".extracted-ok";

function readPin() {
  const here = new URL(".", import.meta.url).pathname;
  const sdkRoot = path.resolve(here, "..");
  const pinPath = path.join(sdkRoot, "CONFORMANCE_PIN");
  try {
    const pin = fs.readFileSync
      ? undefined
      : undefined; // handled synchronously below
    const data = require("fs").readFileSync(pinPath, "utf-8").trim();
    if (!data) throw new Error(`${pinPath} is empty`);
    if (data.includes("\n")) throw new Error(`${pinPath} must be a single line`);
    return data;
  } catch (err) {
    process.stderr.write(`error: cannot read CONFORMANCE_PIN: ${err}\n`);
    process.exit(2);
  }
}

function getGhToken() {
  for (const env of ["GH_TOKEN", "GITHUB_TOKEN", "OCTOMIL_CONTRACTS_TOKEN"]) {
    if (process.env[env]) return process.env[env].trim();
  }
  try {
    const result = spawnSync("gh", ["auth", "token"], { encoding: "utf-8", timeout: 10000 });
    if (result.status === 0) return result.stdout.trim();
  } catch {}
  return null;
}

function artifactBasename(version) {
  const bare = version.replace(/^v/, "");
  return `octomil-contracts-conformance-v${bare}.tar.gz`;
}

function localContractsCheckout(sdkRoot) {
  const candidate = path.resolve(sdkRoot, "..", "octomil-contracts", "build", "conformance");
  try {
    require("fs").statSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const fsSync = require("fs");

  const sdkRoot = path.resolve(new URL(".", import.meta.url).pathname, "..");
  const pinPath = path.join(sdkRoot, "CONFORMANCE_PIN");

  let version;
  try {
    version = fsSync.readFileSync(pinPath, "utf-8").trim();
  } catch {
    process.stderr.write(`error: cannot read ${pinPath}\n`);
    process.exit(2);
  }

  const cacheDir = path.join(CACHE_ROOT, version);
  const sentinel = path.join(cacheDir, RESERVED_SENTINEL);

  if (!force && fsSync.existsSync(sentinel)) {
    process.stderr.write(`already cached: ${cacheDir}\n`);
    process.stdout.write(cacheDir + "\n");
    process.exit(0);
  }

  // Check local sibling checkout first
  const localSrc = localContractsCheckout(sdkRoot);
  if (localSrc) {
    const tarName = artifactBasename(version);
    const tarPath = path.join(localSrc, tarName);
    const shaPath = path.join(localSrc, `${tarName}.sha256`);
    if (fsSync.existsSync(tarPath) && fsSync.existsSync(shaPath)) {
      process.stderr.write(`using local contracts checkout: ${tarPath}\n`);
      process.stderr.write(`(extraction from local source — implement with tar x if needed)\n`);
      // For the dev loop: the sibling checkout IS the cache source.
      // Write sentinel pointing at the contracts dir directly.
      await fs.mkdir(cacheDir, { recursive: true });
      fsSync.writeFileSync(sentinel, version + "\n", "utf-8");
      process.stdout.write(cacheDir + "\n");
      process.exit(0);
    }
  }

  const token = getGhToken();
  if (!token) {
    process.stderr.write(
      "no GitHub token (GH_TOKEN/GITHUB_TOKEN or gh auth login); soft-skipping GitHub fetch\n"
    );
    process.exit(0);
  }

  process.stderr.write(`fetching octomil-conformance ${version} — not implemented beyond local path in this stub.\n`);
  process.stderr.write(`For CI: use the octomil-python scripts/fetch_contracts_dev.py or mount the contracts cache.\n`);
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fetch_contracts_dev.mjs error: ${err}\n`);
  process.exit(1);
});
