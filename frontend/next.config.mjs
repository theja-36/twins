// Next.js 15 standalone server (docs/frontend/architecture.md §12): one public origin behind a TLS reverse proxy, the API on a private network.
// The CSP (per-request nonce) and HSTS (only in host mode, read from the RUNTIME environment) are set in src/middleware.ts; the static security headers are set here.
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // `packages/api-contracts` lives outside this app's directory (browser-safe, no dependencies); tracing must start at the repository root.
  outputFileTracingRoot: repoRoot,
  experimental: { externalDir: true },
  // Lint runs as its own CI step (npm run lint), so the build does not repeat it.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    const common = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    ];
    return [
      { source: "/:path*", headers: common },
      { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }, { key: "Pragma", value: "no-cache" }] },
    ];
  },
};
export default nextConfig;
