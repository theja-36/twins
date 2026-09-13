import type { schema } from "@twins/database";

type NewsEventType = (typeof schema.newsEventTypeEnum.enumValues)[number];

/**
 * Purely deterministic keyword classification (spec: "Do not use AI
 * simply because it is available"). Returns null - not a guess - when no
 * keyword set matches, so an event stays untyped rather than being
 * forced into the nearest category.
 */
const KEYWORD_RULES: Array<{ type: NewsEventType; keywords: string[] }> = [
  { type: "earnings", keywords: ["earnings", "quarterly results", "q1 results", "q2 results", "q3 results", "q4 results", "net profit", "revenue rose", "revenue fell"] },
  { type: "merger_acquisition", keywords: ["acquire", "acquisition", "merger", "to buy", "takeover"] },
  { type: "management_change", keywords: ["ceo steps down", "ceo resigns", "appoints new ceo", "names new ceo", "chief executive resigns", "board appoints"] },
  { type: "dividend", keywords: ["dividend"] },
  { type: "buyback", keywords: ["buyback", "share repurchase"] },
  { type: "bankruptcy", keywords: ["bankruptcy", "files for chapter 11", "insolvency"] },
  { type: "regulatory_action", keywords: ["regulatory action", "fined by", "penalty imposed", "sebi order", "regulator probe"] },
  { type: "exchange_halt", keywords: ["trading halted", "circuit breaker", "exchange halt"] },
  { type: "index_rebalance", keywords: ["index rebalance", "added to the index", "removed from the index"] },
  { type: "major_price_event", keywords: ["shares plunge", "shares surge", "stock crashes", "stock soars"] },
  { type: "liquidity_event", keywords: ["liquidity crunch", "liquidity crisis"] },
  { type: "interest_rate_decision", keywords: ["repo rate", "interest rate decision", "rate hike", "rate cut", "policy rate"] },
  { type: "inflation_release", keywords: ["inflation data", "cpi print", "consumer price index"] },
  { type: "employment_report", keywords: ["jobs report", "unemployment rate", "nonfarm payrolls", "employment report"] },
  { type: "gdp_release", keywords: ["gdp growth", "gdp data", "gross domestic product"] },
  { type: "central_bank_statement", keywords: ["central bank statement", "monetary policy statement", "fomc statement"] },
  { type: "sanctions", keywords: ["sanctions imposed", "new sanctions", "sanctions on"] },
  { type: "conflict_escalation", keywords: ["conflict escalates", "military strike", "war escalation"] },
  { type: "election", keywords: ["general election", "election results", "election victory"] },
  { type: "trade_restriction", keywords: ["trade restriction", "export ban", "import ban"] },
  { type: "tariff", keywords: ["tariff", "tariffs imposed"] },
  { type: "oil_supply_disruption", keywords: ["oil supply disruption", "opec cuts", "oil production cut"] },
  { type: "commodity_move", keywords: ["gold prices", "commodity prices", "crude oil prices"] },
  { type: "currency_event", keywords: ["currency devaluation", "rupee falls", "dollar strengthens", "currency intervention"] },
];

export function classifyEventType(text: string): NewsEventType | null {
  const normalized = text.toLowerCase();
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.type;
    }
  }
  return null;
}
