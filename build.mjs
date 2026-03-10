import { build } from "esbuild";
import { execSync } from "node:child_process";

// ESM + declarations via tsc
execSync("npx tsc", { stdio: "inherit" });

// CJS bundle via esbuild
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/cjs/index.cjs",
  external: ["onnxruntime-node"],
  sourcemap: true,
});

console.log("Build complete.");
