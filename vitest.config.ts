import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["tests/support/networkGuardSetup.ts"],
    env: {
      DATABASE_URL: "postgresql://unit-tests-never-connect.invalid:5432/none",
      REDIS_URL: "redis://localhost:6379",
      TWINS_API_KEY: "test-api-key-default",
      TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-default",
    },
  },
});
