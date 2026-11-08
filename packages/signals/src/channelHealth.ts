/**
 * Channel health (Stage 03, M01-12) and capture timeliness (M01-10 / M01-11). PURE. It describes the CHANNEL'S SILENCE and TWINS' capture delay; it says nothing about whether the channel's calls are any good (that needs resolved outcomes: reliability stays NOT_AVAILABLE until then).
 * Market hours are not modelled: a channel that is quiet overnight is reported QUIET, which is information, not an alarm.
 */
export type ChannelHealthStatus = "NO_DATA" | "ACTIVE" | "QUIET" | "STALE" | "SILENT";
export interface ChannelHealthConfig { quietAfterMinutes: number; staleAfterHours: number; silentAfterDays: number; delayedShareLimit: number; medianDelayLimitSeconds: number }
export const DEFAULT_CHANNEL_HEALTH: ChannelHealthConfig = { quietAfterMinutes: 120, staleAfterHours: 24, silentAfterDays: 7, delayedShareLimit: 0.2, medianDelayLimitSeconds: 600 };
export interface ChannelHealthInput { lastMessageAt: Date | null; messages24h: number; delayedShare24h: number | null; medianCaptureDelaySeconds24h: number | null; now: Date }
export interface ChannelHealth { status: ChannelHealthStatus; lastMessageAgeSeconds: number | null; messages24h: number; capture: "NO_DATA" | "TIMELY" | "DELAYED"; reasons: string[]; reliability: "NOT_AVAILABLE" }
export function assessChannelHealth(i: ChannelHealthInput, cfg: ChannelHealthConfig = DEFAULT_CHANNEL_HEALTH): ChannelHealth {
  const reasons: string[] = [];
  const age = i.lastMessageAt ? Math.max(0, Math.round((i.now.getTime() - i.lastMessageAt.getTime()) / 1000)) : null;
  let status: ChannelHealthStatus;
  if (age === null) { status = "NO_DATA"; reasons.push("NO_MESSAGES_CAPTURED"); }
  else if (age > cfg.silentAfterDays * 86_400) { status = "SILENT"; reasons.push("NO_MESSAGE_FOR_DAYS"); }
  else if (age > cfg.staleAfterHours * 3_600) { status = "STALE"; reasons.push("NO_MESSAGE_FOR_A_DAY"); }
  else if (age > cfg.quietAfterMinutes * 60) { status = "QUIET"; reasons.push("NO_RECENT_MESSAGE"); }
  else status = "ACTIVE";
  let capture: ChannelHealth["capture"] = "NO_DATA";
  if (i.messages24h > 0 && i.delayedShare24h !== null) {
    capture = i.delayedShare24h > cfg.delayedShareLimit || (i.medianCaptureDelaySeconds24h ?? 0) > cfg.medianDelayLimitSeconds ? "DELAYED" : "TIMELY";
    if (capture === "DELAYED") reasons.push("CAPTURE_DELAYED");
  }
  return { status, lastMessageAgeSeconds: age, messages24h: i.messages24h, capture, reasons, reliability: "NOT_AVAILABLE" };
}
