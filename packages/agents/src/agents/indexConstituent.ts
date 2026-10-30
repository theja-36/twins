import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef } from "./common";
import type { Constituent, ConstituentProvider, ConstituentSet, MarketDataProvider, Quote } from "./constituentProviders";
import { signalDirection } from "./macroGlobal";
import { classifyItem, dedupeNews, validateNewsItem, type NewsItem, type NewsProvider } from "./newsProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * Index-Constituent Impact Agent (`index-constituent-impact-v1`, Stage 5 / Task 4). For INDEX signals (underlying in `indexUnderlyings`) it compares the recent moves and news of the index's
 * top-weighted constituents with the signal direction, using INJECTED providers (no external API, no model, never raw message text). It reports what the data shows and infers no causation.
 * For any other underlying the agent is not applicable (NEUTRAL, `applicable: false`).
 *
 *   UNAVAILABLE (never a pass): no constituent provider, an index the provider does not cover, an index / underlying mismatch, malformed data, covered weight below the minimum, too little usable
 *                 (fresh, present) weight among the top constituents, a provider that throws
 *   BLOCKING : a CRITICAL adverse news item (near term) about a constituent with at least the critical weight (configurable BLOCKING | ADVERSE); smaller constituents -> ADVERSE
 *   ADVERSE  : the weighted move of the top constituents against the direction beyond the adverse threshold; one constituent contributing against beyond the single-contribution limit; an
 *              extreme move in a heavy constituent; HIGH adverse news on a heavy constituent
 *   CAUTION  : milder weighted conflict; most weight moving against; mixed (both sides sizeable); a sector holding most of the weight moving against; partial / stale data; MEDIUM adverse news
 *   NEUTRAL  : nothing adverse and no clear support;  SUPPORTIVE: nothing adverse and the weighted move is in the signal direction
 */
export const INDEX_CONSTITUENT_AGENT_ID = "index-constituent-impact-v1";
const MIN = 60_000;

export function indexConstituentContract(): AgentContract {
  return {
    agentId: INDEX_CONSTITUENT_AGENT_ID, agentName: "Index-Constituent Impact Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, applicable: { type: "boolean" }, direction: { type: "string" }, index: { type: "string" }, constituentProvider: { type: "string" }, marketDataProvider: { type: "string" }, consideredCount: { type: "number" },
      consideredWeight: { type: "number" }, usableWeightShare: { type: "number" }, weightedMovePct: { type: "number" }, againstWeightShare: { type: "number" }, withWeightShare: { type: "number" }, topSector: { type: "string" },
      topSectorShare: { type: "number" }, newsItemsConsidered: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null };
const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
const malformed = (): never => unavailable("CONSTITUENT_DATA_MALFORMED", "the constituent provider returned malformed data");
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const safeSym = /^[A-Z0-9&._-]{1,30}$/;

function checkSet(s: ConstituentSet | null, index: string): ConstituentSet {
  if (!s || typeof s !== "object" || typeof s.index !== "string" || Number.isNaN(Date.parse(s.asOf)) || !Array.isArray(s.constituents) || s.constituents.length === 0) return malformed();
  if (s.index.toUpperCase() !== index) return unavailable("INDEX_UNDERLYING_MISMATCH", "the constituent data describes a different index than the signal's underlying");
  const seen = new Set<string>();
  let total = 0;
  for (const c of s.constituents) {
    if (!c || typeof c.symbol !== "string" || !safeSym.test(c.symbol) || seen.has(c.symbol) || !fin(c.weight) || c.weight <= 0 || c.weight > 100 || typeof c.sector !== "string" || !/^[A-Za-z0-9 &._-]{1,40}$/.test(c.sector)) return malformed();
    if ((c.recentChangePct !== null && !fin(c.recentChangePct)) || Number.isNaN(Date.parse(c.dataAsOf)) || (typeof c.index === "string" && c.index.toUpperCase() !== index)) return typeof c.index === "string" && c.index.toUpperCase() !== index ? unavailable("INDEX_UNDERLYING_MISMATCH", "a constituent record belongs to a different index") : malformed();
    seen.add(c.symbol); total += c.weight;
  }
  if (total > 100.5) return malformed();
  return s;
}

export function indexConstituentAgent(rules: AgentRulesConfig, constituents: ConstituentProvider | null, marketData: MarketDataProvider | null, news: NewsProvider | null): AgentDefinition {
  const r = rules.constituent;
  return {
    contract: indexConstituentContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      const underlying = (rd.symbol ?? "").trim().toUpperCase(), market = (rd.market ?? "").trim().toUpperCase();
      if (!market || !underlying || underlying === "UNKNOWN") throw new AgentUnavailableError("MISSING_CONTEXT", "the market or underlying is missing");
      const c = new Collector();
      const siStatus = typeof si?.status === "string" ? si.status.slice(0, 30) : "none";
      c.check();
      if (!r.indexUnderlyings.includes(underlying)) {
        c.add("INFO", "NOT_AN_INDEX_SIGNAL", "The underlying is not one of the configured index underlyings, so constituent impact does not apply.");
        return { ...c.output(evidenceRef("risk_decision", rd.id), { applicable: false, sourceIntelligenceStatus: siStatus }), verdict: "NEUTRAL", confidence: 70 };
      }
      if (!constituents) throw new AgentUnavailableError("CONSTITUENT_PROVIDER_NOT_CONFIGURED", "no index-constituent provider is configured; constituent impact cannot be assessed");
      const now = ctx.now.getTime();
      const guard = async <T>(code: string, message: string, fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof AgentUnavailableError) throw e; return unavailable(code, message); } }; // the provider's own message is never stored

      if (!(await guard("CONSTITUENT_PROVIDER_UNAVAILABLE", "the constituent provider is unavailable", () => constituents.knowsIndex(underlying)))) return unavailable("INDEX_NOT_COVERED", "the constituent provider does not cover this index");
      const set = checkSet(await guard("CONSTITUENT_PROVIDER_UNAVAILABLE", "the constituent provider is unavailable", () => constituents.constituents(underlying)), underlying);
      const covered = set.constituents.reduce((a, x) => a + x.weight, 0);
      if (covered < r.minCoveredWeight) return unavailable("CONSTITUENT_COVERAGE_INSUFFICIENT", "the constituent data covers too little of the index weight");
      const top = [...set.constituents].sort((a, b) => b.weight - a.weight || (a.symbol < b.symbol ? -1 : 1)).filter((x) => x.weight >= r.minWeight).slice(0, r.topCount);
      if (top.length === 0) return unavailable("CONSTITUENT_COVERAGE_INSUFFICIENT", "no constituent reaches the minimum weight");

      // ── quotes (a market-data quote takes precedence over the constituent record's own change) ──
      let quotes: Record<string, Quote> = {};
      if (marketData) {
        const got = await guard("MARKET_DATA_UNAVAILABLE", "the market-data provider is unavailable", () => marketData.quotes({ market: r.quoteMarket, symbols: top.map((x) => x.symbol) }));
        if (typeof got !== "object" || got === null || Array.isArray(got)) return unavailable("MARKET_DATA_MALFORMED", "the market-data provider returned malformed data");
        for (const [k, q] of Object.entries(got)) if (!q || !fin(q.changePct1d) || Math.abs(q.changePct1d) > 100 || Number.isNaN(Date.parse(q.asOf))) return unavailable("MARKET_DATA_MALFORMED", "the market-data provider returned malformed data"); else quotes[k.toUpperCase()] = q;
      }
      interface Row { c: Constituent; change: number; ageMin: number }
      const usable: Row[] = [];
      let unusable = 0, stale = 0;
      c.check();
      for (const x of top) {
        const q = quotes[x.symbol];
        const change = q ? q.changePct1d : x.recentChangePct, asOf = q ? q.asOf : x.dataAsOf;
        const age = (now - Date.parse(asOf)) / MIN;
        if (change === null || age > r.unavailableMinutes || age < -5) { unusable++; continue; }
        if (age > r.staleCautionMinutes) stale++;
        usable.push({ c: x, change, ageMin: age });
      }
      const topWeight = top.reduce((a, x) => a + x.weight, 0), usableWeight = usable.reduce((a, x) => a + x.c.weight, 0);
      const usableShare = usableWeight / topWeight;
      if (usableShare < r.minUsableShare) return unavailable("CONSTITUENT_DATA_INCOMPLETE", "too little of the top constituents' weight has fresh change data");
      if (unusable > 0) c.add("CAUTION", "CONSTITUENT_DATA_PARTIAL", `${unusable} of the ${top.length} top constituents have no usable change data.`, { unusable, considered: top.length });
      if (stale > 0) c.add("CAUTION", "CONSTITUENT_DATA_STALE", `${stale} constituent change value(s) are older than ${r.staleCautionMinutes} minutes.`, { stale });
      if (!marketData) c.add("INFO", "MARKET_DATA_NOT_CONFIGURED", "No market-data provider is configured; the constituent records' own changes were used.");

      const dir = signalDirection((rd.instrumentType ?? "").toLowerCase(), rd.side ?? "", rd.optionType);
      const weightedMove = usable.reduce((a, x) => a + x.c.weight * x.change, 0) / usableWeight;
      let supportive = false, againstShare = 0, withShare = 0, newsCount = 0;
      const sectorWeight = new Map<string, number>(), sectorMove = new Map<string, number>();
      for (const x of usable) { sectorWeight.set(x.c.sector, (sectorWeight.get(x.c.sector) ?? 0) + x.c.weight); sectorMove.set(x.c.sector, (sectorMove.get(x.c.sector) ?? 0) + x.c.weight * x.change); }
      const [topSector, topSectorW] = [...sectorWeight.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0] as [string, number];
      const topSectorShare = topSectorW / usableWeight;
      c.check();
      if (dir === null) c.add("CAUTION", "DIRECTION_UNKNOWN", "The signal direction cannot be derived from its side and option type, so alignment is not assessed.");
      else {
        const aligned = dir * weightedMove;
        if (aligned <= -r.impactAdverse) c.add("ADVERSE", "WEIGHTED_IMPACT_AGAINST", `The weighted move of the top constituents is ${r3(weightedMove)}%, against the signal direction.`, { weightedMovePct: r3(weightedMove) });
        else if (aligned <= -r.impactCaution) c.add("CAUTION", "WEIGHTED_IMPACT_LEANS_AGAINST", `The weighted move of the top constituents is ${r3(weightedMove)}%, leaning against the signal direction.`, { weightedMovePct: r3(weightedMove) });
        else if (aligned >= r.impactCaution) { supportive = true; c.add("INFO", "WEIGHTED_IMPACT_SUPPORTIVE", `The weighted move of the top constituents is ${r3(weightedMove)}%, in the signal direction.`, { weightedMovePct: r3(weightedMove) }); }
        else c.add("INFO", "WEIGHTED_IMPACT_FLAT", `The weighted move of the top constituents is ${r3(weightedMove)}%.`, { weightedMovePct: r3(weightedMove) });
        againstShare = usable.filter((x) => dir * x.change <= -r.moveCaution).reduce((a, x) => a + x.c.weight, 0) / usableWeight;
        withShare = usable.filter((x) => dir * x.change >= r.moveCaution).reduce((a, x) => a + x.c.weight, 0) / usableWeight;
        c.check();
        if (againstShare >= 0.6) c.add("CAUTION", "CONSTITUENT_BREADTH_AGAINST", `${r3(againstShare * 100)}% of the considered weight moved against the signal direction.`, { againstWeightShare: r3(againstShare) });
        else if (againstShare >= 0.35 && withShare >= 0.35) c.add("CAUTION", "MIXED_CONSTITUENT_IMPACT", "Sizeable weight moved both for and against the signal direction.", { againstWeightShare: r3(againstShare), withWeightShare: r3(withShare) });
        for (const x of usable.filter((y) => dir * y.c.weight * y.change / 100 <= -r.singleContributionAdverse).slice(0, 5))
          c.add("ADVERSE", "LARGE_CONSTITUENT_CONTRIBUTION_AGAINST", `${x.c.symbol} (weight ${r3(x.c.weight)}%) moved ${r3(x.change)}%, a large contribution against the signal direction.`, { symbol: x.c.symbol, weight: r3(x.c.weight), changePct: r3(x.change) });
        for (const x of usable.filter((y) => y.c.weight >= r.criticalWeight && Math.abs(y.change) >= r.extremeMove).slice(0, 5))
          c.add("ADVERSE", "EXTREME_CONSTITUENT_MOVE", `${x.c.symbol} (weight ${r3(x.c.weight)}%) moved ${r3(x.change)}% in one session.`, { symbol: x.c.symbol, weight: r3(x.c.weight), changePct: r3(x.change) });
        for (const x of usable.filter((y) => y.c.weight >= r.criticalWeight && dir * y.change <= -r.moveAdverse && Math.abs(y.change) < r.extremeMove).slice(0, 5))
          c.add("CAUTION", "HEAVY_CONSTITUENT_MOVE_AGAINST", `${x.c.symbol} (weight ${r3(x.c.weight)}%) moved ${r3(x.change)}%, against the signal direction.`, { symbol: x.c.symbol, weight: r3(x.c.weight), changePct: r3(x.change) });
      }
      c.check();
      if (topSectorShare >= r.sectorConcentration) {
        const sMove = (sectorMove.get(topSector) as number) / topSectorW;
        if (dir !== null && dir * sMove <= -r.impactCaution) c.add("CAUTION", "SECTOR_CONCENTRATION_AGAINST", `The ${topSector} sector holds ${r3(topSectorShare * 100)}% of the considered weight and moved ${r3(sMove)}%, against the signal direction.`, { sector: topSector, share: r3(topSectorShare), sectorMovePct: r3(sMove) });
        else c.add("INFO", "SECTOR_CONCENTRATION", `The ${topSector} sector holds ${r3(topSectorShare * 100)}% of the considered weight.`, { sector: topSector, share: r3(topSectorShare) });
      }
      const top3 = top.slice(0, 3).reduce((a, x) => a + x.weight, 0);
      if (top3 >= 40) c.add("INFO", "TOP_WEIGHT_CONCENTRATION", `The three heaviest constituents hold ${r3(top3)}% of the index.`, { top3Weight: r3(top3) });

      // ── constituent news ──
      c.check();
      if (!news) c.add("INFO", "CONSTITUENT_NEWS_NOT_CONFIGURED", "No news provider is configured; constituent news was not assessed.");
      else {
        const raw: unknown = await guard("NEWS_PROVIDER_UNAVAILABLE", "the news provider is unavailable", () => news.items({ from: new Date(now - r.newsLookbackMinutes * MIN).toISOString(), to: new Date(now + 5 * MIN).toISOString(), market: r.quoteMarket, symbols: top.map((x) => x.symbol) }));
        if (!Array.isArray(raw)) return unavailable("NEWS_DATA_MALFORMED", "the news provider returned malformed data");
        const valid: NewsItem[] = raw.map((x) => validateNewsItem(x) ?? unavailable("NEWS_DATA_MALFORMED", "the news provider returned malformed data"));
        const { unique, duplicates } = dedupeNews(valid);
        if (duplicates > 0) c.add("INFO", "DUPLICATE_NEWS_IGNORED", `${duplicates} duplicate news item(s) were counted once.`, { duplicates });
        const bySym = new Map(top.map((x) => [x.symbol, x]));
        const policy = { nearTermMinutes: r.nearTermMinutes, sentimentThreshold: r.sentimentThreshold, minReliability: r.minReliability, criticalAdverse: r.criticalEvent };
        const rel = unique.filter((i) => (i.markets.includes("ALL") || i.markets.includes(r.quoteMarket)) && i.symbols.some((s) => bySym.has(s)) && (now - Date.parse(i.publishedAt)) / MIN <= r.newsLookbackMinutes && (now - Date.parse(i.publishedAt)) / MIN >= -5);
        newsCount = rel.length;
        if (dir !== null) {
          const rows = rel.map((i) => { const k = i.symbols.filter((s) => bySym.has(s)).map((s) => bySym.get(s) as Constituent).sort((a, b) => b.weight - a.weight)[0] as Constituent; return { k, cl: classifyItem(i, dir, now, policy) }; });
          const heavy = (k: Constituent): boolean => k.weight >= r.criticalWeight;
          const adverseRows = rows.filter((x) => x.cl.stance === "adverse").map((x) => {
            let level = x.cl.level;
            if (level === "BLOCKING" && !heavy(x.k)) level = "ADVERSE";
            else if (level === "ADVERSE" && x.cl.item.impact === "HIGH" && !heavy(x.k)) level = "CAUTION";
            else if (level === "CAUTION" && !heavy(x.k)) level = "INFO";
            return { ...x, level };
          }).filter((x) => x.level !== "INFO").sort((a, b) => ["BLOCKING", "ADVERSE", "CAUTION"].indexOf(a.level) - ["BLOCKING", "ADVERSE", "CAUTION"].indexOf(b.level) || b.k.weight - a.k.weight).slice(0, 8);
          for (const x of adverseRows) c.add(x.level, x.cl.item.impact === "CRITICAL" ? "CRITICAL_CONSTITUENT_EVENT" : x.cl.item.impact === "HIGH" ? "HIGH_IMPACT_CONSTITUENT_NEWS_AGAINST" : "CONSTITUENT_NEWS_AGAINST",
            `A ${x.cl.item.impact.toLowerCase()}-impact ${x.cl.item.category} item (${x.cl.item.sourceLabel}) about ${x.k.symbol} (weight ${r3(x.k.weight)}%) has sentiment against the signal direction.`, { itemId: x.cl.item.id, symbol: x.k.symbol, weight: r3(x.k.weight), impact: x.cl.item.impact, ageMinutes: Math.round(x.cl.ageMinutes) });
          const sup = rows.filter((x) => x.cl.stance === "supportive" && heavy(x.k) && (x.cl.item.impact === "HIGH" || x.cl.item.impact === "CRITICAL"));
          if (sup.length > 0) { supportive = supportive || adverseRows.length === 0; c.add("INFO", "CONSTITUENT_NEWS_SUPPORTIVE", `${sup.length} high-impact item(s) about heavy constituents lean in the signal direction.`, { count: sup.length }); }
          if (adverseRows.length > 0 && sup.length > 0) c.add("CAUTION", "CONFLICTING_CONSTITUENT_NEWS", "High-impact constituent news leans both for and against the signal direction.", { adverse: adverseRows.length, supportive: sup.length });
        }
      }

      const evidence = [...evidenceRef("risk_decision", rd.id), ...evidenceRef("index_constituents", `${constituents.name}@${set.asOf}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150)), ...(marketData ? evidenceRef("market_data", marketData.name.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150)) : [])];
      const out = c.output(evidence, {
        applicable: true, direction: dir === null ? "UNKNOWN" : dir > 0 ? "BULLISH" : "BEARISH", index: underlying, constituentProvider: constituents.name.slice(0, 80), ...(marketData ? { marketDataProvider: marketData.name.slice(0, 80) } : {}),
        consideredCount: top.length, consideredWeight: r3(topWeight), usableWeightShare: r3(usableShare), weightedMovePct: r3(weightedMove), againstWeightShare: r3(againstShare), withWeightShare: r3(withShare), topSector: topSector.slice(0, 40),
        topSectorShare: r3(topSectorShare), newsItemsConsidered: newsCount, sourceIntelligenceStatus: siStatus,
      });
      if (out.verdict === "SUPPORTIVE" && !supportive) return { ...out, verdict: "NEUTRAL", confidence: 70 };
      return out;
    },
  };
}
