import net from "node:net";

export const EGRESS_CANARY = { host: "1.1.1.1", port: 443 };

/**
 * Fail-closed self-test of the Telegram-only egress firewall, run before the bot talks to anything. True ONLY when a connection to a public
 * non-Telegram host times out or has no route (what the DROP rule produces). A completed connection, a refusal/reset (something answered) or any
 * other error is not proof of a restriction, so the bot refuses to start.
 */
export function egressIsRestricted(connect: typeof net.connect = net.connect, timeoutMs = 4000, target = EGRESS_CANARY): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean, socket?: net.Socket): void => {
      if (done) return;
      done = true;
      socket?.destroy();
      resolve(value);
    };
    let socket: net.Socket;
    try {
      socket = connect({ host: target.host, port: target.port });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => finish(true, socket), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(false, socket);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(error.code === "ENETUNREACH" || error.code === "EHOSTUNREACH" || error.code === "ETIMEDOUT", socket);
    });
  });
}
