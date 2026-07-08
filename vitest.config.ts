import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: the app build uses root "web",
// which would otherwise make vitest look for tests under web/ (it reads
// vite.config.ts by default). This file takes precedence for `vitest`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
