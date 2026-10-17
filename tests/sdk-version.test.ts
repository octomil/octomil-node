import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSdkVersion } from "../src/telemetry.js";

describe("getSdkVersion", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
    expect(getSdkVersion()).toBe(pkg.version);
  });
});
