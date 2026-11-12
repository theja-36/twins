import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@twins/api-contracts": path.resolve(import.meta.dirname, "../packages/api-contracts/src/index.ts"),
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    env: { TWINS_API_BASE_URL: "http://api.invalid:3000", TWINS_COOKIE_MODE: "dev" },
  },
});
