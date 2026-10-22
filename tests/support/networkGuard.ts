/**
 * Test-process network isolation. Installed by tests/support/networkGuardSetup.ts (vitest `setupFiles`, so it runs in
 * every unit and integration test worker BEFORE test code is imported). It refuses, BEFORE any socket is opened or any
 * DNS lookup happens, every JavaScript-level connection to a non-loopback host. Loopback (127.0.0.0/8, ::1, localhost)
 * and Unix-socket paths stay allowed, which covers the approved local PostgreSQL / Redis containers, in-process API
 * injection and test-owned forwarders.
 *
 * Layers (each blocks before transport):
 *   1. globalThis.fetch            - checked on the request URL host, before undici is entered.
 *   2. http.request/get, https.request/get - checked on the destination, before a socket is created.
 *   3. net.Socket.prototype.connect - the single choke point of net.connect / net.createConnection / tls.connect
 *      (TLSSocket extends net.Socket) and of the TCP transport used by pg, ioredis and the bundled undici.
 *
 * NOT covered (see the scope list in the implementation report): code running outside the vitest worker (child
 * processes such as the CLI spawned by tests, tsx workers), dgram/UDP, http2.connect, direct dns.* calls, and
 * native addons.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

export class ExternalNetworkBlockedError extends Error {
  readonly code = "EXTERNAL_NETWORK_BLOCKED";
  constructor(readonly host: string, readonly via: string) {
    super(`EXTERNAL_NETWORK_BLOCKED: tests may not connect to non-loopback host "${host}" (via ${via})`);
    this.name = "ExternalNetworkBlockedError";
  }
}

export interface NetworkGuardStats {
  /** Attempts the guard refused (host + layer). */
  blocked: Array<{ host: string; via: string }>;
  /** Connections that were allowed through to the real transport (loopback / Unix socket only). */
  allowedConnects: number;
}

const GLOBAL_KEY = "__twinsNetworkGuard";
type Holder = { stats: NetworkGuardStats };

export function isLoopbackHost(hostRaw: string | undefined | null): boolean {
  if (hostRaw === undefined || hostRaw === null || hostRaw === "") return true; // Node defaults to localhost
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function hostOfUrl(input: unknown): string | undefined {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(String(input)).hostname;
    if (input && typeof (input as { url?: unknown }).url === "string") return new URL((input as { url: string }).url).hostname;
  } catch {
    return undefined;
  }
  return undefined;
}

export function installNetworkGuard(): NetworkGuardStats {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Holder | undefined;
  if (existing) return existing.stats;
  const stats: NetworkGuardStats = { blocked: [], allowedConnects: 0 };
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = { stats } satisfies Holder;
  const refuse = (host: string, via: string): never => {
    stats.blocked.push({ host, via });
    throw new ExternalNetworkBlockedError(host, via);
  };

  // 1. fetch
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = hostOfUrl(input);
    if (host !== undefined && !isLoopbackHost(host)) refuse(host, "fetch");
    return originalFetch(input, init);
  }) as typeof fetch;

  // 2. http / https request + get
  for (const [mod, name] of [[http, "http"], [https, "https"]] as const) {
    for (const fn of ["request", "get"] as const) {
      const original = mod[fn] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[fn] = (...args: unknown[]) => {
        const a0 = args[0];
        let host: string | undefined;
        if (typeof a0 === "string" || a0 instanceof URL) host = hostOfUrl(a0);
        else if (a0 && typeof a0 === "object") {
          const o = a0 as { hostname?: string; host?: string; socketPath?: string };
          if (o.socketPath) host = undefined;
          else host = o.hostname ?? o.host;
        }
        if (host !== undefined && !isLoopbackHost(host.replace(/:\d+$/, ""))) refuse(host, `${name}.${fn}`);
        return original.apply(mod, args);
      };
    }
  }

  // 3. net.Socket.prototype.connect (net.connect, net.createConnection, tls.connect, pg, ioredis, bundled undici)
  const originalConnect = net.Socket.prototype.connect as (this: net.Socket, ...a: unknown[]) => net.Socket;
  net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const a0 = args[0];
    let host: string | undefined;
    let isPath = false;
    if (Array.isArray(a0)) {
      // Node passes a normalized [options, cb] array internally.
      const o = a0[0] as { host?: string; path?: string } | undefined;
      host = o?.host;
      isPath = Boolean(o?.path);
    } else if (a0 && typeof a0 === "object") {
      const o = a0 as { host?: string; path?: string };
      host = o.host;
      isPath = Boolean(o.path);
    } else if (typeof a0 === "number" || (typeof a0 === "string" && /^\d+$/.test(a0))) {
      host = typeof args[1] === "string" ? args[1] : undefined;
    } else if (typeof a0 === "string") {
      isPath = true; // IPC path
    }
    if (!isPath && !isLoopbackHost(host)) refuse(host ?? "unknown", "net.Socket.connect");
    stats.allowedConnects += 1;
    return originalConnect.apply(this, args);
  };

  syncBuiltinESMExports();
  return stats;
}

export function networkGuardStats(): NetworkGuardStats {
  const holder = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as Holder | undefined;
  if (!holder) throw new Error("network guard is not installed in this test worker");
  return holder.stats;
}
