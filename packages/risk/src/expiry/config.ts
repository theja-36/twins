/**
 * Risk-decision validity windows (Stage 3 / Task 4). A decision is stale once its LATEST version is older than the window of its status. Same pattern
 * as the other risk configuration: documented defaults, strict environment overrides, a malformed value makes the loader throw.
 */
export interface ExpiryConfig {
  pendingMinutes: number;
  approvedForReviewMinutes: number;
  source: Record<string, "default" | "env">;
}
export const DEFAULT_EXPIRY = { pendingMinutes: 30, approvedForReviewMinutes: 15 } as const;
const MAX_MINUTES = 7 * 24 * 60;

function minutes(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]{0,4}$/.test(raw) || Number(raw) > MAX_MINUTES) throw new Error(`${name} must be a whole number of minutes from 1 to ${MAX_MINUTES}`);
  return Number(raw);
}

export function loadExpiryConfig(env: Record<string, string | undefined> = process.env): ExpiryConfig {
  const p = minutes(env, "TWINS_RISK_EXPIRY_PENDING_MINUTES");
  const a = minutes(env, "TWINS_RISK_EXPIRY_APPROVED_MINUTES");
  return {
    pendingMinutes: p ?? DEFAULT_EXPIRY.pendingMinutes,
    approvedForReviewMinutes: a ?? DEFAULT_EXPIRY.approvedForReviewMinutes,
    source: { pendingMinutes: p === undefined ? "default" : "env", approvedForReviewMinutes: a === undefined ? "default" : "env" },
  };
}
export const DEFAULT_EXPIRY_CONFIG: ExpiryConfig = loadExpiryConfig({});

/** Validity window in milliseconds for a stored status; null for statuses that do not expire. */
export function validityMs(status: string, config: ExpiryConfig): number | null {
  if (status === "PENDING") return config.pendingMinutes * 60_000;
  if (status === "APPROVED_FOR_REVIEW") return config.approvedForReviewMinutes * 60_000;
  return null;
}
