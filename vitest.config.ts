import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Exclude agent worktrees — they have independent src/ dirs and should be
    // run from their own branches, not picked up by the main test runner.
    exclude: [".claude-worktrees/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
