import { AgentUnavailableError, type AgentContract, type AgentDefinition } from "../contract";
import { Collector, COMMON_OUTPUT_FIELDS, evidenceRef } from "./common";
import { signalDirection } from "./macroGlobal";
import { classifyItem, dedupeNews, validateNewsItem, type Classified, type NewsItem, type NewsProvider, type SentimentProvider, type SentimentSnapshot } from "./newsProviders";
import type { AgentRulesConfig } from "./rules";

/**
 * News / Sentiment Agent (`news-sentiment-v1`, Stage 5 / Task 4). Describes whether recent structured news and sentiment evidence agrees with, conflicts with, or adds event risk to the
 * signal direction, using INJECTED providers (no external API, no model, never raw message text). It states what the evidence shows and infers no causation.
 *
 *   UNAVAILABLE (never a pass): no news provider, a provider that throws, malformed items, a feed snapshot older than the unavailable limit, a missing market / underlying
 *   BLOCKING : a CRITICAL adverse item inside the near-term window (configurable BLOCKING | ADVERSE); lower-reliability sources are downgraded one level
 *   ADVERSE  : a CRITICAL adverse item older than the near-term window; a HIGH adverse item; conflicting HIGH+ items on both sides; an aggregate sentiment strongly against the direction (enough samples)
 *   CAUTION  : a MEDIUM adverse item; conflicting MEDIUM items; HIGH+ news with no clear direction near-term; a milder aggregate conflict; a stale feed; future-dated or truncated items
 *   NEUTRAL  : no relevant news, or only neutral / minor items;  SUPPORTIVE: nothing adverse and supportive evidence (a supportive MEDIUM+ item or aggregate)
 */
export const NEWS_SENTIMENT_AGENT_ID = "news-sentiment-v1";
const MIN = 60_000;

export function newsSentimentContract(): AgentContract {
  return {
    agentId: NEWS_SENTIMENT_AGENT_ID, agentName: "News / Sentiment Agent", version: "1.0.0",
    requiredInputs: ["risk_decision"], optionalInputs: ["signal_context", "signal_features", "source_intelligence"],
    outputSchema: { fields: {
      ...COMMON_OUTPUT_FIELDS, direction: { type: "string" }, provider: { type: "string" }, sentimentProvider: { type: "string" }, itemsConsidered: { type: "number" }, duplicatesIgnored: { type: "number" }, adverseItems: { type: "number" },
      supportiveItems: { type: "number" }, aggregateScore: { type: "number" }, feedAgeMinutes: { type: "number" }, lookbackMinutes: { type: "number" }, sourceIntelligenceStatus: { type: "string" },
    } },
    timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 0 }, weight: 50, canBlock: true, advisoryOnly: false, dependsOn: [],
  };
}
type Rd = { id?: string; instrumentType?: string | null; market?: string | null; symbol?: string | null; side?: string | null; optionType?: string | null };
const unavailable = (code: string, message: string): never => { throw new AgentUnavailableError(code, message); };
const malformed = (): never => unavailable("NEWS_DATA_MALFORMED", "the news provider returned malformed data");
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

export function newsSentimentAgent(rules: AgentRulesConfig, news: NewsProvider | null, sentiment: SentimentProvider | null): AgentDefinition {
  const r = rules.news;
  return {
    contract: newsSentimentContract(),
    async run(ctx) {
      const rd = ctx.inputs["risk_decision"] as Rd | null;
      const si = (ctx.inputs["source_intelligence"] ?? null) as { status?: string } | null;
      if (!rd) throw new AgentUnavailableError("MISSING_CONTEXT", "the risk-decision context is missing");
      if (!news) throw new AgentUnavailableError("NEWS_PROVIDER_NOT_CONFIGURED", "no news provider is configured; news evidence cannot be assessed");
      const market = (rd.market ?? "").trim().toUpperCase(), underlying = (rd.symbol ?? "").trim().toUpperCase();
      if (!market || !underlying || underlying === "UNKNOWN") throw new AgentUnavailableError("MISSING_CONTEXT", "the market or underlying is missing");
      const now = ctx.now.getTime();
      const c = new Collector();

      // ── feed freshness ──
      c.check();
      let feedAge: number | undefined;
      if (news.asOf === null) c.add("CAUTION", "NEWS_FEED_AS_OF_UNKNOWN", "The news feed carries no snapshot time.");
      else {
        feedAge = (now - Date.parse(news.asOf)) / MIN;
        if (Number.isNaN(feedAge)) return malformed();
        if (feedAge > r.unavailableMinutes) return unavailable("NEWS_FEED_TOO_OLD", "the news feed snapshot is too old to show whether recent news exists");
        if (feedAge < -r.futureToleranceMinutes) return unavailable("NEWS_FEED_FROM_FUTURE", "the news feed snapshot is dated in the future");
        if (feedAge > r.staleCautionMinutes) c.add("CAUTION", "NEWS_FEED_STALE", `The news feed snapshot is ${Math.round(feedAge)} minutes old.`, { ageMinutes: Math.round(feedAge) });
      }

      // ── fetch, validate, deduplicate ──
      let raw: unknown;
      try { raw = await news.items({ from: new Date(now - r.lookbackMinutes * MIN).toISOString(), to: new Date(now + r.futureToleranceMinutes * MIN).toISOString(), market, symbols: [underlying] }); } catch { return unavailable("NEWS_PROVIDER_UNAVAILABLE", "the news provider is unavailable"); } // the provider's own message is never stored
      if (!Array.isArray(raw)) return malformed();
      const valid: NewsItem[] = raw.map((x) => validateNewsItem(x) ?? malformed());
      const { unique, duplicates } = dedupeNews(valid);
      c.check();
      if (duplicates > 0) c.add("INFO", "DUPLICATE_NEWS_IGNORED", `${duplicates} duplicate news item(s) were counted once.`, { duplicates });
      let relevant = unique.filter((i) => (i.markets.includes("ALL") || i.markets.includes(market)) && (i.symbols.includes("*") || i.symbols.includes(underlying)));
      const future = relevant.filter((i) => (now - Date.parse(i.publishedAt)) / MIN < -r.futureToleranceMinutes);
      if (future.length > 0) c.add("CAUTION", "NEWS_FUTURE_DATED", `${future.length} news item(s) are dated in the future and were ignored.`, { count: future.length });
      relevant = relevant.filter((i) => { const a = (now - Date.parse(i.publishedAt)) / MIN; return a >= -r.futureToleranceMinutes && a <= r.lookbackMinutes; });
      if (relevant.length > r.maxItems) { c.add("CAUTION", "NEWS_TRUNCATED", `More than ${r.maxItems} relevant items; the most recent were assessed.`); relevant = [...relevant].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, r.maxItems); }

      // ── direction and classification ──
      const dir = signalDirection((rd.instrumentType ?? "").toLowerCase(), rd.side ?? "", rd.optionType);
      c.check();
      let adverse: Classified[] = [], supportive: Classified[] = [], aggregateScore: number | undefined, supportiveEvidence = false;
      if (dir === null) c.add("CAUTION", "DIRECTION_UNKNOWN", "The signal direction cannot be derived from its side and option type, so alignment is not assessed.");
      else {
        const policy = { nearTermMinutes: r.nearTermMinutes, sentimentThreshold: r.sentimentThreshold, minReliability: r.minReliability, criticalAdverse: r.criticalAdverse };
        const classified = relevant.map((i) => classifyItem(i, dir, now, policy));
        adverse = classified.filter((x) => x.stance === "adverse");
        supportive = classified.filter((x) => x.stance === "supportive");
        for (const a of adverse.filter((x) => x.level !== "INFO")) {
          const code = a.item.impact === "CRITICAL" ? (a.nearTerm ? "CRITICAL_ADVERSE_NEWS_NEAR_TERM" : "CRITICAL_ADVERSE_NEWS") : a.item.impact === "HIGH" ? "HIGH_IMPACT_ADVERSE_NEWS" : "ADVERSE_NEWS";
          c.add(a.level, code, `A ${a.item.impact.toLowerCase()}-impact ${a.item.category} item (${a.item.sourceLabel}) has sentiment against the signal direction.`,
            { itemId: a.item.id, impact: a.item.impact, category: a.item.category, ageMinutes: Math.round(a.ageMinutes), ...(a.downgraded ? { downgradedForReliability: true } : {}) });
        }
        const lowAdverse = adverse.filter((x) => x.level === "INFO").length;
        if (lowAdverse > 0) c.add("INFO", "MINOR_ADVERSE_NEWS", `${lowAdverse} low-impact or low-reliability item(s) lean against the signal direction.`, { count: lowAdverse });
        const strongSupport = supportive.filter((x) => x.item.impact !== "LOW");
        if (strongSupport.length > 0) { supportiveEvidence = true; c.add("INFO", "SUPPORTIVE_NEWS", `${strongSupport.length} item(s) of at least medium impact lean in the signal direction.`, { count: strongSupport.length, highImpact: strongSupport.filter((x) => x.item.impact === "HIGH" || x.item.impact === "CRITICAL").length }); }
        // conflicting evidence
        const advMed = adverse.filter((x) => x.item.impact !== "LOW"), supMed = strongSupport;
        c.check();
        if (advMed.length > 0 && supMed.length > 0) {
          const high = (l: Classified[]) => l.some((x) => x.item.impact === "HIGH" || x.item.impact === "CRITICAL");
          c.add(high(advMed) && high(supMed) ? "ADVERSE" : "CAUTION", "CONFLICTING_NEWS", "Recent items of at least medium impact lean both for and against the signal direction.", { adverse: advMed.length, supportive: supMed.length });
          supportiveEvidence = false;
        }
        const mixed = classified.filter((x) => (x.stance === "mixed" || x.stance === "neutral") && x.nearTerm && (x.item.impact === "HIGH" || x.item.impact === "CRITICAL"));
        if (mixed.length > 0) c.add("CAUTION", "HIGH_IMPACT_NEWS_DIRECTION_UNCLEAR", `${mixed.length} high-impact item(s) in the near term have no clear direction relative to the signal.`, { count: mixed.length, itemId: mixed[0]!.item.id });
        // aggregate sentiment
        c.check();
        if (sentiment) {
          let snap: SentimentSnapshot | null;
          try { snap = await sentiment.sentiment({ market, symbol: underlying }); } catch { return unavailable("SENTIMENT_PROVIDER_UNAVAILABLE", "the sentiment provider is unavailable"); }
          if (snap !== null) {
            if (!snap || !Number.isFinite(snap.score) || snap.score < -1 || snap.score > 1 || !Number.isInteger(snap.sampleSize) || snap.sampleSize < 0 || Number.isNaN(Date.parse(snap.asOf))) return unavailable("SENTIMENT_DATA_MALFORMED", "the sentiment provider returned malformed data");
            aggregateScore = snap.score;
            const age = (now - Date.parse(snap.asOf)) / MIN;
            const aligned = dir * snap.score;
            if (age > r.staleCautionMinutes) c.add("CAUTION", "SENTIMENT_STALE", `The aggregate sentiment is ${Math.round(age)} minutes old.`, { ageMinutes: Math.round(age) });
            else if (aligned <= -r.aggregateAdverse) c.add(snap.sampleSize >= r.aggregateMinSample ? "ADVERSE" : "CAUTION", snap.sampleSize >= r.aggregateMinSample ? "AGGREGATE_SENTIMENT_AGAINST" : "AGGREGATE_SENTIMENT_AGAINST_LOW_SAMPLE", `Aggregate sentiment is ${r3(snap.score)} against the signal direction (${snap.sampleSize} samples).`, { score: r3(snap.score), sampleSize: snap.sampleSize });
            else if (aligned <= -r.aggregateCaution) c.add("CAUTION", "AGGREGATE_SENTIMENT_LEANS_AGAINST", `Aggregate sentiment is ${r3(snap.score)}, leaning against the signal direction.`, { score: r3(snap.score), sampleSize: snap.sampleSize });
            else if (aligned >= r.aggregateCaution && snap.sampleSize >= r.aggregateMinSample && adverse.every((x) => x.level === "INFO")) { supportiveEvidence = supportiveEvidence || true; c.add("INFO", "AGGREGATE_SENTIMENT_SUPPORTIVE", `Aggregate sentiment is ${r3(snap.score)}, in the signal direction.`, { score: r3(snap.score), sampleSize: snap.sampleSize }); }
          } else c.add("INFO", "AGGREGATE_SENTIMENT_MISSING", "The sentiment provider has no aggregate for this underlying.");
        } else c.add("INFO", "SENTIMENT_PROVIDER_NOT_CONFIGURED", "No sentiment provider is configured; only item-level sentiment was assessed.");
      }
      if (relevant.length === 0) c.add("INFO", "NO_RECENT_NEWS", "No relevant news items were found in the lookback window.");

      const ids = [...adverse, ...supportive].map((x) => x.item.id).slice(0, 10);
      const evidence = [...evidenceRef("risk_decision", rd.id), ...evidenceRef("news_feed", `${news.name}${news.asOf ? `@${news.asOf}` : ""}`.replace(/[^A-Za-z0-9_.:/#@=-]/g, "_").slice(0, 150)), ...ids.flatMap((id) => evidenceRef("news_item", id))];
      const out = c.output(evidence, {
        direction: dir === null ? "UNKNOWN" : dir > 0 ? "BULLISH" : "BEARISH", provider: news.name.slice(0, 80), ...(sentiment ? { sentimentProvider: sentiment.name.slice(0, 80) } : {}), itemsConsidered: relevant.length, duplicatesIgnored: duplicates,
        adverseItems: adverse.length, supportiveItems: supportive.length, lookbackMinutes: r.lookbackMinutes, sourceIntelligenceStatus: typeof si?.status === "string" ? si.status.slice(0, 30) : "none",
        ...(aggregateScore === undefined ? {} : { aggregateScore: r3(aggregateScore) }), ...(feedAge === undefined ? {} : { feedAgeMinutes: Math.max(0, Math.round(feedAge)) }),
      });
      if (out.verdict === "SUPPORTIVE" && !supportiveEvidence) return { ...out, verdict: "NEUTRAL", confidence: 70 };
      return out;
    },
  };
}
