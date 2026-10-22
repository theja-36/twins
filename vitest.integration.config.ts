import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/support/networkGuardSetup.ts"],
    testTimeout: 20000,
    globalSetup: ["tests/integration/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
    },
  },
});
