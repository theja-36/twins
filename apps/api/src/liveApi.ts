import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import type { Db } from "@twins/database";
import { evaluateLiveGuard } from "@twins/config";
import { evaluateReadiness, getPaperSwitch, loadPaperConfig } from "@twins/paper";
import { buildSourceHealth, indexContexts, observeProviderFiles } from "@twins/providers";
import { clampLimit, failRoute, guardWith, type Authorizer } from "./apiSupport.js";

/**
 * Live data routes for the frontend: INTERNAL, bearer-protected, READ-ONLY. Intake (counts and bounded metadata, never message text or raw payloads; channel ids masked), the Kite snapshot
 * generation and index prices (local files, read-only mount), the provider data files (counts and ages), and the paper-trading enable checklist. Nothing here writes anything.
 */
const mask = (id: string): string => (id.length > 4 ? `***${id.slice(-4)}` : "***");
const readJson = (path: string, maxBytes = 2_000_000): unknown => { try { if (statSync(path).size > maxBytes) return null; return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const isoOrNull = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const ageSec = (iso: string | null, now: Date): number | null => (iso ? Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000)) : null);
const KINDS = ["instrument-reference", "quotes", "option-quotes", "option-chain", "last-price", "ohlc"] as const;


// ── Telegram channel / claim views (Phase 2 backend). READ-ONLY, parsed fields only: never message text, never the raw fragments stored inside a claim. ──
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strIn = (v: unknown, allowed: readonly string[]): string | null => (typeof v === "string" && allowed.includes(v) ? v : null);
const CODE_RE = /^[a-z0-9_.]{1,60}$/;
const SEVERITIES = ["info", "warn", "warning", "insufficient", "reject", "error"];

export function safeClaimView(claim: unknown): Record<string, unknown> | null {
  if (!isObj(claim)) return null;
  const entry = isObj(claim["entry"]) ? claim["entry"] : {};
  const expiry = isObj(claim["expiry"]) ? claim["expiry"] : {};
  return {
    action: strIn(claim["action"], ["buy", "sell"]),
    underlying: strIn(claim["underlying"], ["NIFTY", "BANKNIFTY", "SENSEX"]),
    strike: numOrNull(claim["strike"]), optionType: strIn(claim["optionType"], ["CE", "PE"]),
    entry: { type: strIn(entry["type"], ["at", "above", "below", "near", "range", "market", "unspecified"]), price: numOrNull(entry["price"]), low: numOrNull(entry["low"]), high: numOrNull(entry["high"]) },
    stopLoss: numOrNull(claim["stopLoss"]),
    targets: Array.isArray(claim["targets"]) ? claim["targets"].map(numOrNull).filter((x): x is number => x !== null).slice(0, 6) : [],
    levelBasis: strIn(claim["levelBasis"], ["premium", "underlying", "unspecified"]),
    levelBasisInferred: isObj(claim["levelBasisInference"]), levelBasisConflict: claim["levelBasisConflict"] === true,
    expiry: { status: strIn(expiry["status"], ["missing", "period_word", "year_two_digit", "day_month", "year_dependent", "full", "invalid"]), day: numOrNull(expiry["day"]), month: numOrNull(expiry["month"]), year: numOrNull(expiry["year"]) },
  };
}
export function safeReasons(reasons: unknown): Array<{ code: string; severity: string }> {
  if (!Array.isArray(reasons)) return [];
  const out: Array<{ code: string; severity: string }> = [];
  for (const r of reasons) { if (isObj(r) && typeof r["code"] === "string" && CODE_RE.test(r["code"])) out.push({ code: r["code"], severity: strIn(r["severity"], SEVERITIES) ?? "info" }); if (out.length >= 16) break; }
  return out;
}

export function marketOpenIst(now: Date): boolean {
  const ist = new Date(now.getTime() + 330 * 60_000), dow = ist.getUTCDay(), m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return dow >= 1 && dow <= 5 && m >= 9 * 60 + 15 && m < 15 * 60 + 30;
}

export function readSnapshotView(dir: string, now: Date) {
  const gen = readJson(join(dir, ".snapshot-generation.json"), 100_000) as { status?: unknown; generation?: unknown } | null;
  const files = KINDS.map((kind) => {
    try { const p = join(dir, `${kind}.json`), st = statSync(p); const doc = kind === "instrument-reference" ? null : (readJson(p, 3_000_000) as { as_of?: unknown } | null); const asOf = isoOrNull(doc?.as_of) ?? st.mtime.toISOString(); return { kind, present: true, bytes: st.size, asOf, ageSeconds: ageSec(asOf, now) }; }
    catch { return { kind, present: false, bytes: 0, asOf: null, ageSeconds: null }; }
  });
  const ohlc = readJson(join(dir, "ohlc.json")), last = readJson(join(dir, "last-price.json")), quotes = readJson(join(dir, "quotes.json")) as { quotes?: Record<string, unknown> } | null;
  const optionQuotes = readJson(join(dir, "option-quotes.json")) as { quotes?: Record<string, unknown>; as_of?: unknown } | null;
  const indices = ohlc && last ? indexContexts(ohlc, last, now, 24 * 7).map((i) => ({ market: i.market, symbol: i.symbol, level: i.level, previousClose: i.previousClose, changePct1d: i.changePct1d, asOf: i.asOf, ageSeconds: ageSec(i.asOf, now) })) : [];
  const visible = gen !== null || files.some((f) => f.present);
  return { visible, generation: gen ? { status: typeof gen.status === "string" ? gen.status : "unknown", id: typeof gen.generation === "string" ? gen.generation : null } : null, files, indices, quoteCount: quotes?.quotes ? Object.keys(quotes.quotes).length : 0, optionQuoteCount: optionQuotes?.quotes ? Object.keys(optionQuotes.quotes).length : 0 };
}

export function readProvidersView(dir: string, now: Date) {
  const names = ["news", "sentiment", "economic-calendar", "macro-context", "market-quotes", "holiday-calendar", "index-constituents"];
  let present: string[] = [];
  try { present = readdirSync(dir); } catch { /* the directory does not exist yet */ }
  return names.map((n) => {
    const doc = present.includes(`${n}.json`) ? (readJson(join(dir, `${n}.json`), 10_000_000) as Record<string, unknown> | null) : null;
    const asOf = isoOrNull(doc?.["as_of"]);
    const count = doc ? (Array.isArray(doc["items"]) ? doc["items"].length : Array.isArray(doc["events"]) ? doc["events"].length : doc["entries"] && typeof doc["entries"] === "object" ? Object.keys(doc["entries"] as object).length : doc["contexts"] && typeof doc["contexts"] === "object" ? Object.keys(doc["contexts"] as object).length : doc["quotes"] && typeof doc["quotes"] === "object" ? Object.keys(doc["quotes"] as object).length : doc["indices"] && typeof doc["indices"] === "object" ? Object.keys(doc["indices"] as object).length : doc["markets"] && typeof doc["markets"] === "object" ? Object.keys(doc["markets"] as object).length : 0) : null;
    return { name: n, present: doc !== null, format: typeof doc?.["format"] === "string" ? doc["format"] : null, source: typeof doc?.["source"] === "string" ? doc["source"].slice(0, 40) : null, asOf, ageSeconds: ageSec(asOf, now), count };
  });
}

export function registerLiveRoutes(app: FastifyInstance, deps: { db: Db; authorized: Authorizer; snapshotDir: string; providersDir: string; adminConfigured: boolean; readSafety: () => Promise<unknown> | unknown; now?: () => Date; /** Whether a chat id is on the ingestion allow-list; absent => `captureAllowed` is reported as unknown. */ isChatApproved?: (chatId: string) => boolean }): void {
  const guard = guardWith(deps.authorized), nowOf = deps.now ?? (() => new Date());

  app.get<{ Querystring: { limit?: string } }>("/intake/status", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = clampLimit(request.query.limit, 25, 100);
    if (limit === null) return reply.code(400).send({ error: "invalid_input" });
    try {
      const rows = async (q: ReturnType<typeof sql>) => (await deps.db.execute(q)).rows as Array<Record<string, unknown>>;
      const [byStatus, recent, last] = await Promise.all([
        rows(sql`select status, count(*)::int as n, min(received_at) as oldest from telegram_intake_outbox group by status`),
        rows(sql`select id, message_type, status, attempt_count, received_at, completed_at, channel_id from telegram_intake_outbox order by received_at desc limit ${limit}`),
        rows(sql`select max(completed_at) as at, max(received_at) as received from telegram_intake_outbox`),
      ]);
      const now = nowOf();
      const counts = Object.fromEntries(byStatus.map((r) => [String(r["status"]), Number(r["n"])]));
      const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);
      return {
        counts, total: Object.values(counts).reduce((a, b) => a + b, 0),
        oldestOpenSeconds: ageSec(iso(byStatus.filter((r) => ["PENDING", "PROCESSING", "FAILED"].includes(String(r["status"]))).map((r) => r["oldest"]).filter(Boolean).sort()[0] ?? null), now),
        lastReceivedAt: iso(last[0]?.["received"]), lastCompletedAt: iso(last[0]?.["at"]),
        recent: recent.map((r) => ({ id: String(r["id"]).slice(0, 8), type: String(r["message_type"]), status: String(r["status"]), attempts: Number(r["attempt_count"]), receivedAt: iso(r["received_at"]), completedAt: iso(r["completed_at"]), channel: mask(String(r["channel_id"])) })),
      };
    } catch (error) { return failRoute(request, reply, error); }
  });


  /** Phase 2: channels TWINS has captured from, with counts. Identifiers masked; no message content. */
  app.get("/telegram/channels", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    try {
      const rows = async (q: ReturnType<typeof sql>) => (await deps.db.execute(q)).rows as Array<Record<string, unknown>>;
      const [chans, claims] = await Promise.all([
        rows(sql`select s.id, s.channel_identifier, s.display_name, s.chat_id,
          count(m.id) filter (where m.edit_date is null and (m.origin_message_id is null or m.origin_message_id = m.external_message_id))::int as messages,
          count(m.id) filter (where m.edit_date is not null or (m.origin_message_id is not null and m.origin_message_id <> m.external_message_id))::int as revisions,
          min(m.message_timestamp) as first_at, max(m.message_timestamp) as last_at
          from telegram_sources s left join telegram_messages m on m.telegram_source_id = s.id group by s.id order by max(m.message_timestamp) desc nulls last limit 200`),
        rows(sql`select m.telegram_source_id as sid, c.result_kind, count(*)::int as n from options_claims c join telegram_messages m on m.id = c.telegram_message_id group by 1, 2`),
      ]);
      const now = nowOf();
      const iso = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);
      const byChan = new Map<string, Record<string, number>>();
      for (const r of claims) { const k = String(r["sid"]); const o = byChan.get(k) ?? {}; o[String(r["result_kind"])] = Number(r["n"]); byChan.set(k, o); }
      return {
        channels: chans.map((r) => {
          const last = iso(r["last_at"]), chat = typeof r["chat_id"] === "string" ? r["chat_id"] : null, kinds = byChan.get(String(r["id"])) ?? {};
          return {
            id: String(r["id"]).slice(0, 8), channel: mask(String(r["channel_identifier"])), name: typeof r["display_name"] === "string" ? r["display_name"].replace(/[^A-Za-z0-9 _.:@-]/g, "_").slice(0, 60) : null,
            messages: Number(r["messages"]), revisions: Number(r["revisions"]), claims: { claim: kinds["claim"] ?? 0, ambiguous: kinds["ambiguous"] ?? 0, unsupported: kinds["unsupported"] ?? 0 },
            firstMessageAt: iso(r["first_at"]), lastMessageAt: last, lastMessageAgeSeconds: ageSec(last, now),
            captureAllowed: deps.isChatApproved && chat !== null ? deps.isChatApproved(chat) : null,
          };
        }),
      };
    } catch (error) { return failRoute(request, reply, error); }
  });

  /** Phase 2: parsed options claims, newest first. Explicit field allow-list: no message text, no raw fragments, no free-text descriptions. */
  app.get<{ Querystring: { limit?: string; channel?: string } }>("/telegram/claims", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    const limit = clampLimit(request.query.limit, 25, 100);
    const channel = request.query.channel;
    if (limit === null || (channel !== undefined && !/^\*\*\*[A-Za-z0-9_.:@-]{1,4}$/.test(channel))) return reply.code(400).send({ error: "invalid_input" });
    try {
      const tail = channel === undefined ? null : channel.slice(3);
      const found = (await deps.db.execute(sql`select c.id, c.parser_version, c.result_kind, c.assessment_outcome, c.claim, c.reasons, m.message_timestamp, s.channel_identifier
        from options_claims c join telegram_messages m on m.id = c.telegram_message_id join telegram_sources s on s.id = m.telegram_source_id
        where (${tail}::text is null or right(s.channel_identifier, 4) = ${tail}) order by m.message_timestamp desc, c.id desc limit ${limit}`)).rows as Array<Record<string, unknown>>;
      const now = nowOf();
      return {
        claims: found.map((r) => {
          const at = r["message_timestamp"] ? new Date(String(r["message_timestamp"])).toISOString() : null;
          return {
            id: String(r["id"]).slice(0, 8), channel: mask(String(r["channel_identifier"])), receivedAt: at, ageSeconds: ageSec(at, now),
            parserVersion: /^[a-z0-9._-]{1,40}$/.test(String(r["parser_version"])) ? String(r["parser_version"]) : "unknown",
            resultKind: strIn(r["result_kind"], ["claim", "ambiguous", "unsupported"]), assessmentOutcome: strIn(r["assessment_outcome"], ["INSUFFICIENT_EVIDENCE", "REJECT"]),
            claim: safeClaimView(r["claim"]), blockers: safeReasons(r["reasons"]),
          };
        }),
      };
    } catch (error) { return failRoute(request, reply, error); }
  });

  /** Source health profile (P0 #2): READ-ONLY, from the provider files only. The exporter's pass log is not visible to the API, so `passLogAvailable` is false here; the CLI adds it. */
  app.get("/market/sources", async (request, reply) => { if (!guard(request, reply)) return reply; try { return buildSourceHealth({ now: nowOf(), observations: observeProviderFiles(deps.providersDir) }); } catch (error) { return failRoute(request, reply, error); } });

  app.get("/market/snapshot", async (request, reply) => { if (!guard(request, reply)) return reply; try { return { ...readSnapshotView(deps.snapshotDir, nowOf()), providers: readProvidersView(deps.providersDir, nowOf()) }; } catch (error) { return failRoute(request, reply, error); } });

  app.get("/paper/readiness", async (request, reply) => {
    if (!guard(request, reply)) return reply;
    try {
      const now = nowOf(), snap = readSnapshotView(deps.snapshotDir, now);
      const rc = (await Promise.resolve(deps.readSafety()).catch(() => null)) as { killSwitchActive?: boolean; intakeEnabled?: boolean } | null;
      const cfg = (() => { try { return loadPaperConfig(); } catch { return null; } })();
      const sw = await getPaperSwitch(deps.db).catch(() => null);
      const tables = await deps.db.execute(sql`select (select count(*) from paper_trades) as a, (select count(*) from paper_outcomes) as b`).then(() => true, () => false);
      const approved = await deps.db.execute(sql`select count(*)::int as n from risk_approvals where action = 'APPROVE'`).then((r) => Number((r.rows[0] as { n: number }).n), () => 0);
      const nifty = snap.indices.find((i) => i.symbol === "NIFTY") ?? snap.indices[0];
      return evaluateReadiness({
        killSwitchActive: typeof rc?.killSwitchActive === "boolean" ? rc.killSwitchActive : undefined, intakeEnabled: typeof rc?.intakeEnabled === "boolean" ? rc.intakeEnabled : undefined,
        liveGuardPasses: evaluateLiveGuard(process.env).ok, tradingModePaper: (process.env["TRADING_MODE"] ?? "paper") === "paper", paperTablesReadable: tables, switchReadable: sw !== null, switchOn: Boolean(sw?.enabled), armedByHost: Boolean(cfg?.enabled),
        adminConfigured: deps.adminConfigured, snapshotComplete: snap.visible ? snap.generation?.status === "complete" : null, snapshotAgeSec: snap.files.find((f) => f.kind === "last-price")?.ageSeconds ?? null,
        priceAgeSec: nifty?.ageSeconds ?? null, maxPriceAgeSec: cfg?.maxPriceAgeSeconds ?? 120, marketOpen: marketOpenIst(now), approvedDecisions: approved,
      });
    } catch (error) { return failRoute(request, reply, error); }
  });
}
