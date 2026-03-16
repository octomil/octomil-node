/**
 * Integration test: SmolVLM2 vision model through the SDK pipeline.
 *
 * Exercises: LocalFileModelRuntime → ModelRuntime → OctomilClient.responses.create()
 * Requires: llama-cli at /opt/homebrew/bin/llama-cli
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { LocalFileModelRuntime } from "../../src/runtime/engines/local-file-runtime.js";
import { ModelRef } from "../../src/model-ref.js";
import type { ModelRuntime } from "../../src/runtime/core/model-runtime.js";

// ---------------------------------------------------------------------------
// llama.cpp CLI adapter — wraps the binary as a ModelRuntime
// ---------------------------------------------------------------------------

const LLAMA_CLI = "/opt/homebrew/bin/llama-cli";
const MODEL_PATH =
  "/Users/seanb/Developer/Octomil/models/smolvlm2-500m/SmolVLM2-500M-Video-Instruct-Q8_0.gguf";
const MMPROJ_PATH =
  "/Users/seanb/Developer/Octomil/models/smolvlm2-500m/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf";

class LlamaVisionRuntime implements ModelRuntime {
  private modelPath: string;
  private mmprojPath: string;

  constructor(modelPath: string, mmprojPath: string) {
    this.modelPath = modelPath;
    this.mmprojPath = mmprojPath;
  }

  async createSession(): Promise<void> {}

  async run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const prompt = (input["prompt"] as string) || "Describe this image.";
    const imagePath = input["imagePath"] as string;

    if (!imagePath) {
      throw new Error("No imagePath provided");
    }

    const args = [
      `"${LLAMA_CLI}"`,
      `-m "${this.modelPath}"`,
      `--mmproj "${this.mmprojPath}"`,
      `--image "${imagePath}"`,
      `-p "${prompt}"`,
      `-n 100`,
      `--temp 0.1`,
      `--no-display-prompt`,
    ].join(" ");

    try {
      const output = execSync(args, {
        timeout: 60000,
        stdio: ["pipe", "pipe", "pipe"],
      })
        .toString()
        .trim();

      return { text: output, finishReason: "stop" };
    } catch (e: any) {
      // llama-cli may write output to stderr
      const stderr = e.stderr?.toString() || "";
      const stdout = e.stdout?.toString() || "";
      return { text: stdout || stderr, finishReason: "error" };
    }
  }

  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const canRun =
  fs.existsSync(LLAMA_CLI) &&
  fs.existsSync(MODEL_PATH) &&
  fs.existsSync(MMPROJ_PATH);

describe.skipIf(!canRun)("SmolVLM2 vision model (integration)", () => {
  let testImagePath: string;

  beforeAll(() => {
    // Create a simple test image using ImageMagick or a pre-existing one
    testImagePath = "/tmp/octomil_test_image.png";
    try {
      execSync(
        `sips -s format png --resampleWidth 256 --resampleHeight 256 /System/Library/Desktop\\ Pictures/*.heic -o "${testImagePath}" 2>/dev/null || true`,
      );
    } catch {}

    // Fallback: create a solid color PNG via python
    if (!fs.existsSync(testImagePath)) {
      execSync(`python3 -c "
import struct, zlib
def create_png(path, w=64, h=64, r=255, g=0, b=0):
    raw = b''
    for y in range(h):
        raw += b'\\x00' + bytes([r, g, b]) * w
    compressed = zlib.compress(raw)
    def chunk(ctype, data):
        c = ctype + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    with open(path, 'wb') as f:
        f.write(b'\\x89PNG\\r\\n\\x1a\\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', compressed))
        f.write(chunk(b'IEND', b''))
create_png('${testImagePath}')
"`);
    }
  });

  it("describes an image via LocalFileModelRuntime", async () => {
    const llamaRuntime = new LlamaVisionRuntime(MODEL_PATH, MMPROJ_PATH);
    const localRuntime = new LocalFileModelRuntime("smolvlm2-500m", MODEL_PATH);
    localRuntime.setDelegate(llamaRuntime);

    const result = await localRuntime.run({
      prompt: "What do you see in this image? Be brief.",
      imagePath: testImagePath,
    });

    console.log("Vision result:", result["text"]);

    expect(result["text"]).toBeTruthy();
    expect(typeof result["text"]).toBe("string");
    expect((result["text"] as string).length).toBeGreaterThan(5);
  });

  it("resolves via ModelRef.id", () => {
    const ref = ModelRef.id("smolvlm2-500m");
    expect(ref.type).toBe("id");
    expect(ref.id).toBe("smolvlm2-500m");
  });
});
