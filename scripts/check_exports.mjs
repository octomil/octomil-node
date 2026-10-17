import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
const targets = [pkg.main, pkg.module, pkg.types];
const walk = (v) => {
  if (typeof v === "string") targets.push(v);
  else if (v && typeof v === "object") Object.values(v).forEach(walk);
};
walk(pkg.exports);

const missing = [...new Set(targets.filter(Boolean))].filter((t) => !existsSync(t));
if (missing.length > 0) {
  console.error(`package.json points at missing files: ${missing.join(", ")}`);
  process.exit(1);
}
