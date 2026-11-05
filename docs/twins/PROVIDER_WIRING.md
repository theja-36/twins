# Provider wiring (structure; superseded by PROVIDERS.md)

> **Update 2026-11-06:** real exporters now exist (`packages/providers`); see [PROVIDERS.md](PROVIDERS.md) for what is wired, verified and still missing. This page keeps the original structure notes.

Five data kinds the research agents need have **no writer yet**, so the agents that depend on them report UNAVAILABLE (never a pass) and a shadow assessment is INCOMPLETE/BLOCKED. `packages/agents/src/exporters/stubs.ts` records, per kind, the exact file, format id, agent setting and credential an exporter will need. The stubs are inert (no network, no credential access, no file writes) and unit-tested against the settings the rules loader really reads.

| Kind | File(s) written into the snapshot directory | Agent settings to point at it | Agent(s) waiting | Owner must provide |
|---|---|---|---|---|
| calendar | `holiday-calendar.json` (`twins-holiday-calendar-v1`), `economic-calendar.json` (`twins-economic-calendar-v1`) | `TWINS_AGENT_HOLIDAY_CALENDAR`, `TWINS_AGENT_ECONOMIC_CALENDAR` = `file:/var/lib/twins-snapshots/<file>` | market-calendar-v1 | economic-calendar vendor + API key, or a maintained file |
| news | `news.json` (`twins-news-v1`) | `TWINS_AGENT_NEWS_PROVIDER` | news-sentiment-v1 | news vendor + API key |
| sentiment | `sentiment.json` (`twins-sentiment-v1`) | `TWINS_AGENT_SENTIMENT_PROVIDER` | news-sentiment-v1 | sentiment source + API key |
| macro | `macro-context.json` (`twins-macro-context-v1`) | `TWINS_AGENT_MACRO_PROVIDER` | macro-global-v1 | macro / global-markets vendor + API key |
| market-data | `index-constituents.json`, `market-quotes.json` | `TWINS_AGENT_CONSTITUENT_PROVIDER`, `TWINS_AGENT_MARKET_DATA_PROVIDER` | index-constituent-impact-v1 | constituent list + quote source |

Order of work when the owner is ready: pick a vendor (Q-004) and supply the key as a host-only secret; build the matching exporter as its own reviewed task (atomic generation publish, as the Kite exporter does); then change the setting. Nothing is asked of the owner until that point.
