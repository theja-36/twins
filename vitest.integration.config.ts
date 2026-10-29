import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // One file at a time: the files share one database, and every runtime harness runs the real outbox reconciler, which works on ALL due rows.
    fileParallelism: false,
    setupFiles: ["tests/support/networkGuardSetup.ts", "tests/support/runtimeStateSetup.ts"],
    testTimeout: 20000,
    globalSetup: ["tests/integration/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
    },
  },
});
