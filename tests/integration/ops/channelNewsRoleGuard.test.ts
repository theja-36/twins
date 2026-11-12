/** The channel-news job runs as the runtime role (compose profile `news`), so outside local development it refuses to run on a privileged database role (exit 82), like the long-running services. Real connection, no injected handle. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../../../scripts/ops/channel-news-export";
import { requireTestDatabaseUrl } from "../targetConfig";

const URL_ = requireTestDatabaseUrl();
const run = async (env: Record<string, string>) => { let out = "", err = ""; const code = await runCli([], { env: { DATABASE_URL: URL_, TWINS_PROVIDERS_DIR: mkdtempSync(join(tmpdir(), "news-")), ...env }, out: (l) => { out += l; }, err: (l) => { err += l; } }); return { code, out, err }; };
describe("channel-news-export role guard", () => {
  for (const appEnv of ["staging", "production", ""]) it(`refuses to run as the owner/superuser role when APP_ENV is ${appEnv === "" ? "unset" : appEnv} (exit 82), and prints no connection detail`, async () => {
    const r = await run(appEnv === "" ? {} : { APP_ENV: appEnv }); expect(r.code).toBe(82); expect(r.err).toMatch(/runtime role separation violated \(.*role_is:rolsuper/); expect(r.err + r.out).not.toMatch(/ci_only_not_a_secret|postgres(ql)?:\/\//);
  });
  it("does not apply the guard in local development (APP_ENV=development): it gets past it (and may then fail for unrelated reasons, but never with exit 82)", async () => {
    const r = await run({ APP_ENV: "development" }); expect(r.code).not.toBe(82);
  });
});
