import { defineConfig } from "@playwright/test";

const WEB = 3100, STUB = 4010;
// Locally set PW_CHANNEL=chrome to use the installed Chrome; CI installs Playwright's chromium instead.
export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${WEB}`, ...(process.env["PW_CHANNEL"] ? { channel: process.env["PW_CHANNEL"] } : {}), trace: "retain-on-failure" },
  webServer: [
    { command: "node e2e/stubBackend.mjs", url: `http://127.0.0.1:${STUB}/__log`, reuseExistingServer: false, env: { STUB_PORT: String(STUB) } },
    {
      command: "node .next/standalone/frontend/server.js",
      url: `http://127.0.0.1:${WEB}/login`, reuseExistingServer: false, timeout: 120_000,
      env: { PORT: String(WEB), HOSTNAME: "127.0.0.1", NODE_ENV: "production", TWINS_PUBLIC_ORIGIN: `http://127.0.0.1:${WEB}`, TWINS_API_BASE_URL: `http://127.0.0.1:${STUB}`, TWINS_COOKIE_MODE: "dev", TWINS_ALLOW_INSECURE_COOKIES: "true", TWINS_ENABLE_DESIGN_GALLERY: "true", TWINS_TRUST_PROXY_HEADER: "x-forwarded-for" },
    },
  ],
});
