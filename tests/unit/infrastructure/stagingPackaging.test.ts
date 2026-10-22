import { readFileSync, existsSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

// Static checks only: no docker, no network. (Compose validation with `docker compose config` was run by hand.)
const read = (p: string) => readFileSync(p, "utf8");
// Comments are stripped so prose about a service cannot be mistaken for configuration of the preceding one.
const compose = read("infrastructure/staging/docker-compose.staging.yml").replace(/^\s*#.*$/gm, "").replace(/\s+#.*$/gm, "");
const env = read("infrastructure/staging/staging.env.example");
const dockerfile = read("infrastructure/staging/Dockerfile");

/** The text of one top-level service block. */
function service(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:\\n|^networks:)`, "m").exec(compose);
  if (!m) throw new Error(`service ${name} not found`);
  return m[1] ?? "";
}

describe("staging packaging (static)", () => {
  it("publishes no database or Redis port and publishes the API on loopback only", () => {
    expect(service("postgres")).not.toMatch(/^\s+ports:/m);
    expect(service("redis")).not.toMatch(/^\s+ports:/m);
    expect(service("worker")).not.toMatch(/^\s+ports:/m);
    const ports = [...compose.matchAll(/^\s+- "([^"]*:\d+)"$/gm)].map((m) => m[1]);
    expect(ports).toEqual(["127.0.0.1:${TWINS_API_HOST_PORT:-4110}:4000"]);
  });
  it("fixes the safety posture as literals and never takes it from the env file", () => {
    expect(compose).toMatch(/LIVE_TRADING: "false"/);
    expect(compose).toMatch(/TRADING_MODE: paper/);
    expect(compose).toMatch(/APP_ENV: staging/);
    expect(env).not.toMatch(/^(LIVE_TRADING|TRADING_MODE|APP_ENV)=/m);
    expect(compose).not.toMatch(/LIVE_TRADING: "?true/);
  });
  it("keeps providers, Telegram registration and contract masters off", () => {
    expect(compose).not.toMatch(/TELEGRAM_BOT_TOKEN|OPENROUTER|BROKER_|MARKET_DATA_API_KEY|NEWS_PROVIDER|TWINS_OPTIONS_/);
    expect(env.replace(/^#.*$/gm, "")).not.toMatch(/TELEGRAM_BOT_TOKEN|OPENROUTER|BROKER_|TWINS_OPTIONS_/);
    expect(service("scheduler")).toMatch(/profiles: \["scheduler"\]/);
    expect(service("scheduler")).toMatch(/MARKET_WATCHLIST: ""/);
  });
  it("makes migration an explicit one-shot profile, never automatic", () => {
    const m = service("migrate");
    expect(m).toMatch(/profiles: \["migrate"\]/);
    expect(m).toMatch(/restart: "no"/);
    for (const s of ["api", "worker", "scheduler", "postgres", "redis"]) expect(service(s)).not.toMatch(/migrate/);
    expect(dockerfile).not.toMatch(/db:migrate|migrate\.ts/);
  });
  it("uses a private internal data network and keeps the worker off the edge network", () => {
    expect(compose).toMatch(/twins_data:\n\s+internal: true/);
    expect(service("worker")).toMatch(/networks: \[twins_data\]/);
    expect(service("postgres")).toMatch(/networks: \[twins_data\]/);
    expect(service("redis")).toMatch(/networks: \[twins_data\]/);
  });
  it("has placeholders only and requires every secret", () => {
    for (const line of env.split("\n").filter((l) => /(PASSWORD|KEY|SECRET)=/.test(l))) expect(line, line).toMatch(/=CHANGE_ME_/);
    for (const v of ["POSTGRES_PASSWORD", "REDIS_PASSWORD", "TWINS_API_KEY", "TELEGRAM_WEBHOOK_SECRET"]) expect(compose).toContain(`\${${v}:?`);
    expect(existsSync("infrastructure/staging/staging.env")).toBe(false);
  });
  it("sets health checks, limits, log rotation and graceful stop", () => {
    for (const s of ["postgres", "redis", "api"]) expect(service(s)).toMatch(/healthcheck:/);
    for (const s of ["postgres", "redis", "api", "worker", "scheduler", "migrate"]) expect(service(s), s).toMatch(/mem_limit:/);
    expect(compose).toMatch(/max-size: "10m"/);
    expect(compose).toMatch(/max-file: "3"/);
    expect(compose.match(/stop_grace_period:/g)?.length).toBeGreaterThanOrEqual(5);
    expect(compose).toMatch(/init: true/);
    expect(compose).toMatch(/no-new-privileges/);
  });
  it("never puts the Redis password in process arguments and runs Redis unprivileged", () => {
    const r = service("redis");
    expect(r).not.toMatch(/--requirepass/);
    expect(r).toMatch(/redis-auth\.conf/);
    expect(r).toMatch(/user: redis/);
  });
  it("routes ONLY GET /health on twins.theja.tech through the existing Traefik, with TWINS-only names and a rate limit", () => {
    const api = service("api");
    const labels = [...api.matchAll(/- '(traefik\.[^']+)'/g)].map((m) => m[1] as string);
    expect(labels.length).toBeGreaterThan(10);
    // the router rules are exactly Host + Path(/health); nothing broader, no webhook or bearer routes
    const rules = labels.filter((l) => /\.rule=/.test(l));
    expect(rules).toHaveLength(2);
    for (const r of rules) expect(r.split(".rule=")[1]).toBe("Host(`twins.theja.tech`) && Path(`/health`)");
    expect(labels.join("\n")).not.toMatch(/PathPrefix|webhooks|options-claims|signals|HostRegexp/);
    // unique TWINS names for every router, service and middleware
    for (const l of labels.filter((x) => /^traefik\.http\.(routers|services|middlewares)\./.test(x))) expect(l).toMatch(/^traefik\.http\.(routers|services|middlewares)\.twins-staging-/);
    expect(labels).toContain("traefik.enable=true");
    expect(labels).toContain("traefik.docker.network=coolify");
    expect(labels).toContain("traefik.http.services.twins-staging-api.loadbalancer.server.port=4000");
    expect(labels).toContain("traefik.http.routers.twins-staging-https.tls.certresolver=letsencrypt");
    expect(labels).toContain("traefik.http.middlewares.twins-staging-ratelimit.ratelimit.average=10");
    expect(labels).toContain("traefik.http.middlewares.twins-staging-ratelimit.ratelimit.burst=20");
    expect(labels).toContain("traefik.http.middlewares.twins-staging-redirect.redirectscheme.scheme=https");
    expect(api).toMatch(/networks: \[twins_data, twins_edge, coolify\]/);
    expect(compose).toMatch(/coolify:\n\s+external: true/);
    // only the API carries Traefik labels and only the API joins the shared network
    for (const sname of ["postgres", "redis", "worker", "scheduler", "migrate"]) {
      expect(service(sname), sname).not.toMatch(/traefik\./);
      expect(service(sname), sname).not.toMatch(/coolify/);
    }
  });
  it("never resolves dependencies by an ambiguous bare hostname on a service attached to the shared coolify network", () => {
    // Regression: joining `coolify` made the bare aliases `postgres`/`redis` resolve to Coolify's own containers.
    const shared = (service: string) => new RegExp(`networks: \\[[^\\]]*\\bcoolify\\b[^\\]]*\\]`).test(service);
    const urlHosts = (block: string) => [...block.matchAll(/^\s+(?:DATABASE_URL|REDIS_URL): .*@([^:/\s@]+)[:/]/gm)].map((m) => m[1] as string);
    const attached = ["api", "worker", "scheduler", "migrate", "postgres", "redis"].filter((n) => shared(service(n)));
    expect(attached).toEqual(["api"]); // only the API joins the shared network
    // the API overrides both URLs with the unique, project-scoped container names
    expect(urlHosts(service("api")).sort()).toEqual(["twins-staging-postgres-1", "twins-staging-redis-1"]);
    for (const h of urlHosts(service("api"))) expect(h).toMatch(/^twins-staging-/);
    // credentials/database name are still the required variables, not literals
    expect(service("api")).toMatch(/DATABASE_URL: postgresql:\/\/\$\{POSTGRES_USER:\?[^}]*\}:\$\{POSTGRES_PASSWORD:\?[^}]*\}@twins-staging-postgres-1:5432\/\$\{POSTGRES_DB:\?[^}]*\}/);
    expect(service("api")).toMatch(/REDIS_URL: redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]*\}@twins-staging-redis-1:6379/);
    // services that are NOT on the shared network keep the shared anchor (bare names are unambiguous on twins_data only)
    expect(compose).toMatch(/x-app-env: &app-env[\s\S]*?@postgres:5432[\s\S]*?@redis:6379/);
    for (const n of ["worker", "scheduler", "migrate"]) expect(service(n), n).not.toMatch(/DATABASE_URL|REDIS_URL/);
  });
  it("passes the Telegram intake guards explicitly to BOTH the API and the worker, deny-by-default and options-only", () => {
    for (const name of ["api", "worker"]) {
      const block = service(name);
      expect(block, name).toMatch(/TWINS_TELEGRAM_ALLOWED_CHAT_IDS: \$\{TWINS_TELEGRAM_ALLOWED_CHAT_IDS:-\}/); // empty default = no chat approved
      expect(block, name).toMatch(/TWINS_TELEGRAM_OPTIONS_ONLY: "true"/); // a literal: the env file cannot switch it off
    }
    // not in the shared anchor (scheduler/migrate neither need nor receive them) and not taken from the env file for options-only
    const anchor = /x-app-env: &app-env\n([\s\S]*?)^services:/m.exec(compose)?.[1] ?? "";
    expect(anchor).not.toMatch(/TWINS_TELEGRAM/);
    expect(compose).not.toMatch(/TWINS_TELEGRAM_OPTIONS_ONLY: \$\{/);
    for (const name of ["scheduler", "migrate"]) expect(service(name), name).not.toMatch(/TWINS_TELEGRAM/);
  });
  it("the intended staging configuration approves no chat yet: the template leaves the allowlist empty", () => {
    expect(env).toMatch(/^TWINS_TELEGRAM_ALLOWED_CHAT_IDS=$/m);
    expect(env).not.toMatch(/^TWINS_TELEGRAM_ALLOWED_CHAT_IDS=.+/m);
    expect(env).toMatch(/separate approval/);
    expect(env).not.toMatch(/TELEGRAM_BOT_TOKEN=/);
  });
  it("builds from the staging host's source tree, resolved against the compose file's own location", () => {
    const m = /build:\n\s+context: (\S+)\n\s+dockerfile: (\S+)/.exec(service("api"));
    expect(m, "api has a build block").not.toBeNull();
    const [, context, dockerfile] = m as RegExpExecArray;
    // Compose resolves a relative context against the directory of the compose file. On the staging host that is:
    const composeDir = "/opt/twins-staging/infrastructure/staging";
    expect(posix.resolve(composeDir, context as string)).toBe("/opt/twins-staging/src");
    // The Dockerfile path is relative to the CONTEXT and must name the Dockerfile that exists at that place in the source tree.
    expect(dockerfile).toBe("infrastructure/staging/Dockerfile");
    expect(existsSync(dockerfile as string)).toBe(true);
    // The old context (../..) is the directory ABOVE the source tree on the host and must not come back.
    expect(posix.resolve(composeDir, "../..")).toBe("/opt/twins-staging");
    expect(context).not.toBe("../..");
    // Only the API declares a build; everything else runs the already-built image and never builds or pulls.
    expect(compose.match(/^\s+build:/gm)?.length).toBe(1);
  });
  it("every path the Dockerfile COPYs exists in the source tree and is not removed by the build context's .dockerignore", () => {
    const ignore = read(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
    const copied = [...dockerfile.matchAll(/^COPY (.+) \.\/?(\S*)$/gm)].flatMap((m) => (m[1] as string).split(/\s+/));
    expect(copied.length).toBeGreaterThan(6);
    for (const src of copied) {
      const path = src.replace(/^\.\//, "");
      expect(existsSync(path), `${path} exists`).toBe(true);
      expect(ignore.includes(path), `${path} is not ignored`).toBe(false);
    }
    // the Dockerfile itself and the workspace manifests must stay in the context
    expect(ignore.some((p) => p === "infrastructure" || p === "infrastructure/staging" || p === "infrastructure/staging/Dockerfile")).toBe(false);
    expect(ignore).toContain("infrastructure/staging/*.env"); // a filled staging.env can never enter the build context
    for (const dir of ["apps", "services", "packages", "adapters"]) expect(ignore.includes(dir) || ignore.includes(`${dir}/`)).toBe(false);
  });
  it("a new image gets its own tag and never overwrites the running one: all four app services share one tag variable, default `local`", () => {
    expect(compose.match(/image: twins-staging:\$\{TWINS_IMAGE_TAG:-local\}/g)?.length).toBe(4);
    expect(compose).not.toMatch(/image: twins-staging:local\b/); // no hard-coded tag left
    expect(compose.match(/pull_policy: never/g)?.length).toBe(4); // an unknown tag fails instead of being pulled
    expect(env).toMatch(/TWINS_IMAGE_TAG/);
  });
  it("keeps the working networking and routing: no public Telegram webhook or bearer route, unique API names, API-only coolify", () => {
    const api = service("api");
    expect(api).not.toMatch(/webhooks/);
    expect(api).not.toMatch(/PathPrefix|options-claims|signals/);
    expect(api.match(/Path\(`\/health`\)/g)?.length).toBeGreaterThanOrEqual(1);
    expect([...api.matchAll(/Path\(`([^`]*)`\)/g)].map((m) => m[1])).toEqual(expect.arrayContaining(["/health"]));
    expect([...new Set([...api.matchAll(/Path\(`([^`]*)`\)/g)].map((m) => m[1]))]).toEqual(["/health"]);
    expect(api).toMatch(/@twins-staging-postgres-1:5432/);
    expect(api).toMatch(/@twins-staging-redis-1:6379/);
    expect(api).toMatch(/- "127\.0\.0\.1:\$\{TWINS_API_HOST_PORT:-4110\}:4000"/);
    expect(api).toMatch(/networks: \[twins_data, twins_edge, coolify\]/);
    for (const name of ["worker", "postgres", "redis", "scheduler", "migrate"]) expect(service(name), name).not.toMatch(/coolify/);
  });
  it("pins PostgreSQL 16 and Redis 7 as the project is tested, and the app image never pulls", () => {
    expect(read(".github/workflows/ci.yml")).toMatch(/postgres:16-alpine/);
    expect(read(".github/workflows/ci.yml")).toMatch(/redis:7-alpine/);
    expect(service("postgres")).toMatch(/image: postgres:16-alpine/);
    expect(service("redis")).toMatch(/image: redis:7-alpine/);
    expect(compose.match(/pull_policy: never/g)?.length).toBe(4);
  });
  it("Dockerfile runs as non-root, has no CMD and does not copy env files or data", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^CMD|^ENTRYPOINT/m);
    expect(dockerfile).not.toMatch(/COPY .*\.env|COPY data|COPY \. /);
    const ignore = read(".dockerignore");
    for (const p of [".env", "data", "node_modules", ".git"]) expect(ignore).toContain(p);
  });
  it("backup scripts refuse to run without --yes, restore only to a scratch database, and state the off-site caveat", () => {
    const b = read("infrastructure/staging/backup-postgres.sh");
    const r = read("infrastructure/staging/restore-check-postgres.sh");
    expect(b).toMatch(/--yes/);
    expect(b).toMatch(/NOT off-site/);
    expect(r).toMatch(/twins_restore_check/);
    expect(r).not.toMatch(/dropdb[^\n]*\$POSTGRES_DB/);
    expect(b + r).not.toMatch(/crontab|systemctl|cron\.d/);
  });
});
