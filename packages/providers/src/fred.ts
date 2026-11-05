import type { Fetcher } from "./http";

/** Minimal FRED (St. Louis Fed) client: observations and release dates. The API key lives only in the URL it builds; it is never logged and no error carries a URL. */
export const FRED_HOST = "api.stlouisfed.org";
export interface FredObservation { date: string; value: number }
export interface FredReleaseDate { releaseId: number; name: string; date: string }
const ymd = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[A-Za-z0-9]{16,64}$/;

export function createFredClient(o: { apiKey: string; fetcher: Fetcher }) {
  if (!KEY.test(o.apiKey)) throw new Error("FRED API key has an unexpected shape"); // the key is never echoed
  const u = (path: string, params: Record<string, string>): string => `https://${FRED_HOST}/fred/${path}?${new URLSearchParams({ ...params, api_key: o.apiKey, file_type: "json" }).toString()}`;
  return {
    async observations(seriesId: string, limit = 12): Promise<FredObservation[]> {
      if (!/^[A-Z0-9_]{2,30}$/.test(seriesId)) throw new Error("bad series id");
      const j = JSON.parse(await o.fetcher(u("series/observations", { series_id: seriesId, sort_order: "desc", limit: String(Math.min(Math.max(2, limit), 100)) }))) as { observations?: Array<{ date?: unknown; value?: unknown }> };
      if (!Array.isArray(j.observations)) throw new Error("unexpected FRED answer");
      return j.observations.flatMap((x) => {
        const v = typeof x.value === "string" ? Number(x.value) : NaN; // FRED marks a missing value with "."
        return typeof x.date === "string" && ymd.test(x.date) && Number.isFinite(v) ? [{ date: x.date, value: v }] : [];
      }).sort((a, b) => (a.date < b.date ? -1 : 1)); // oldest first
    },
    async releaseDates(from: string, to: string): Promise<FredReleaseDate[]> {
      if (!ymd.test(from) || !ymd.test(to)) throw new Error("bad date");
      const j = JSON.parse(await o.fetcher(u("releases/dates", { realtime_start: from, realtime_end: to, include_release_dates_with_no_data: "true", order_by: "release_date", sort_order: "asc", limit: "1000" }))) as { release_dates?: Array<{ release_id?: unknown; release_name?: unknown; date?: unknown }> };
      if (!Array.isArray(j.release_dates)) throw new Error("unexpected FRED answer");
      return j.release_dates.flatMap((x) => (typeof x.release_id === "number" && typeof x.release_name === "string" && typeof x.date === "string" && ymd.test(x.date) && x.date >= from && x.date <= to ? [{ releaseId: x.release_id, name: x.release_name, date: x.date }] : []));
    },
  };
}
export type FredClient = ReturnType<typeof createFredClient>;
