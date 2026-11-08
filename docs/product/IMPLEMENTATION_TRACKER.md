# TWINS implementation tracker

> GENERATED from `docs/product/tracker.json` by `node scripts/product/tracker.mjs render`. Edit the JSON, never this file. Rules (enforced by `tests/unit/product/tracker.test.ts`): IMPLEMENTED and VERIFIED need evidence, BLOCKED needs a blocker, and VERIFIED is reserved for evidence gathered by the testing stage.

Requirements: **386**. NOT_STARTED: 267 · IN_PROGRESS: 36 · IMPLEMENTED: 82 · BLOCKED: 0 · VERIFIED: 1

## Summary by module

| Module | Name | Total | NOT_STARTED | IN_PROGRESS | IMPLEMENTED | BLOCKED | VERIFIED |
|---|---|---|---|---|---|---|---|
| M01 | Signal Intelligence & Telegram Integration | 25 | 8 | 0 | 17 | 0 | 0 |
| M02 | Signal Understanding & Classification | 13 | 12 | 0 | 1 | 0 | 0 |
| M03 | Evidence Ledger & Historical Pattern Intelligence | 13 | 7 | 0 | 6 | 0 | 0 |
| M04 | Research & Validation AI Agents | 27 | 5 | 6 | 16 | 0 | 0 |
| M05 | Market Intelligence & Regime Detection | 14 | 10 | 0 | 4 | 0 | 0 |
| M06 | Channel Strategy Learning Engine | 39 | 39 | 0 | 0 | 0 | 0 |
| M07 | Strategy Intelligence & Learning Database | 17 | 17 | 0 | 0 | 0 | 0 |
| M08 | Capital Management & Position Sizing | 20 | 20 | 0 | 0 | 0 | 0 |
| M09 | Confidence Scoring & Signal Strength | 20 | 20 | 0 | 0 | 0 | 0 |
| M10 | Risk Management & Capital Protection | 25 | 14 | 0 | 11 | 0 | 0 |
| M11 | Pre-Trade What-If Simulator | 12 | 12 | 0 | 0 | 0 | 0 |
| M12 | Decision Engine & Explainable Decisions | 29 | 17 | 11 | 1 | 0 | 0 |
| M13 | Human Approval & Execution | 29 | 19 | 0 | 10 | 0 | 0 |
| M14 | Trade Management & Monitoring | 13 | 5 | 0 | 8 | 0 | 0 |
| M15 | Outcome Learning & Performance Analytics | 15 | 15 | 0 | 0 | 0 | 0 |
| M16 | Independent Opportunity Engine | 13 | 13 | 0 | 0 | 0 | 0 |
| MU | Multi-user architecture (Part 4) | 19 | 4 | 15 | 0 | 0 | 0 |
| UI | Frontend screens (Part 5.4) | 30 | 30 | 0 | 0 | 0 | 0 |
| PF | Platform foundation (Phase 01) | 13 | 0 | 4 | 8 | 0 | 1 |

## M01 — Signal Intelligence & Telegram Integration

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M01-01 | Required functionality | Multiple Telegram channel support. | telegram_sources + capture reads approved chats | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-02 | Required functionality | Real-time message listener. | services/telegram-capture listener and POST /webhooks/telegram | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-03 | Required functionality | Channel management. | read-only: GET /telegram/channels; the allow-list is a host setting (no write route) | 03 | NOT_STARTED |  |  |
| M01-04 | Required functionality | Raw message storage. | telegram_messages, append-only evidence events | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-05 | Required functionality | Message parsing and structured extraction. | packages/signals/src/extract.ts (parser v3) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-06 | Required functionality | Signal identification. | extract.ts kinds: signal / options_claim / ambiguous / unsupported / none | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-07 | Required functionality | Message edit and delete tracking. | telegram_message_events (seen, edited_observed, deleted_observed) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-08 | Required functionality | Duplicate detection. | packages/ingestion/src/dedupe.ts + idempotency keys | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-09 | Required functionality | Malformed signal detection. | result kinds ambiguous / unsupported | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-10 | Required functionality | Delayed signal detection. | partial: decision validity windows only (risk/src/expiry) | 03 | NOT_STARTED |  |  |
| M01-11 | Required functionality | Signal freshness and validity. | partial: 15-minute approval window (risk/src/expiry) | 03 | NOT_STARTED |  |  |
| M01-12 | Required functionality | Channel health monitoring. | partial: last message age in GET /telegram/channels | 03 | NOT_STARTED |  |  |
| M01-13 | Required functionality | Historical message ingestion. | packages/historical import + capture-export (offline CLI) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-14 | Required functionality | Source reliability tracking. | partial: offline scorecards and trust tiers, not wired to live data | 03 | NOT_STARTED |  |  |
| M01-15 | Information to extract | Symbol and underlying. | options_claims.underlying | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-16 | Information to extract | CE / PE. | options_claims.option_type | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-17 | Information to extract | Strike price. | options_claims.strike | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-18 | Information to extract | Expiry. | options_claims.expiry (day/month; year often missing) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-19 | Information to extract | Entry price or entry range. | options_claims.entry (above/at/range) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-20 | Information to extract | Stop-loss. | options_claims.stop_loss + level basis | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-21 | Information to extract | Multiple targets. | options_claims.targets | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-22 | Information to extract | Signal timestamp. | telegram_messages.message_timestamp | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M01-23 | Information to extract | Signal type. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M01-24 | Information to extract | Intraday, positional, scalping or other strategy classification. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M01-25 | Information to extract | Relevant instructions and conditions. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |

## M02 — Signal Understanding & Classification

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M02-01 | Required functionality | Signal type classification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-02 | Required functionality | Market and instrument identification. | options claim fields; instrument-verification agent / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M02-03 | Required functionality | Strategy identification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-04 | Required functionality | Breakout classification. | partial: breakout detection exists only inside technical/price-action agents / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-05 | Required functionality | Reversal classification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-06 | Required functionality | Momentum classification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-07 | Required functionality | Gap strategy classification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-08 | Required functionality | Scalping classification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-09 | Required functionality | Entry condition extraction. | partial: entry kinds above / at / range / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-10 | Required functionality | Exit pattern extraction. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-11 | Required functionality | Risk-profile identification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-12 | Required functionality | Setup-context reconstruction. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M02-13 | Required functionality | Structure validation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |

## M03 — Evidence Ledger & Historical Pattern Intelligence

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M03-01 | Required functionality | Immutable original message storage. | append-only triggers on telegram tables | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M03-02 | Required functionality | Edit and deletion history. | telegram_message_events | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M03-03 | Required functionality | Signal revision tracking. | packages/ingestion/src/telegramRevisions.ts | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M03-04 | Required functionality | Evidence references. | signal_evidence, agent_evidence_references | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M03-05 | Required functionality | Historical signal database. | historical_* tables (import, outcomes, scorecards, patterns) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M03-06 | Required functionality | Similar signal matching. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M03-07 | Required functionality | Pattern library. | offline pattern definitions and confidence (not live) | 03 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M03-08 | Required functionality | Setup similarity analysis. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M03-09 | Required functionality | Market-regime matching. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M03-10 | Required functionality | Volatility matching. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M03-11 | Required functionality | Time-of-day matching. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M03-12 | Required functionality | Historical outcome matching. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |
| M03-13 | Required functionality | Evidence completeness checks. | none identified in the Phase 00 audit | 03 | NOT_STARTED |  |  |

## M04 — Research & Validation AI Agents

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M04-01 | Agent responsibilities | Clearly defined input schema. | agent contract in packages/agents/src/contract.ts | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M04-02 | Agent responsibilities | Clearly defined output schema. | agent contract in packages/agents/src/contract.ts | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M04-03 | Agent responsibilities | Evidence references. | agent_evidence_references | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M04-04 | Agent responsibilities | Confidence or assessment fields where applicable. | none identified in the Phase 00 audit | 04 | NOT_STARTED |  |  |
| M04-05 | Agent responsibilities | Reasoning summary. | none identified in the Phase 00 audit | 04 | NOT_STARTED |  |  |
| M04-06 | Agent responsibilities | Risk flags. | none identified in the Phase 00 audit | 04 | NOT_STARTED |  |  |
| M04-07 | Agent responsibilities | Execution status. | none identified in the Phase 00 audit | 04 | NOT_STARTED |  |  |
| M04-08 | Agent responsibilities | Error and unavailable-state handling. | UNAVAILABLE verdict and error codes in the contract | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M04-09 | Verdict vocabulary | SUPPORTIVE | spec vocabulary + mapping in packages/types/src/platform/verdict.ts (UNAVAILABLE -> INCOMPLETE); agents not yet adopted | 04 | IN_PROGRESS |  |  |
| M04-10 | Verdict vocabulary | CAUTION | spec vocabulary + mapping in packages/types/src/platform/verdict.ts (UNAVAILABLE -> INCOMPLETE); agents not yet adopted | 04 | IN_PROGRESS |  |  |
| M04-11 | Verdict vocabulary | NEUTRAL | spec vocabulary + mapping in packages/types/src/platform/verdict.ts (UNAVAILABLE -> INCOMPLETE); agents not yet adopted | 04 | IN_PROGRESS |  |  |
| M04-12 | Verdict vocabulary | ADVERSE | spec vocabulary + mapping in packages/types/src/platform/verdict.ts (UNAVAILABLE -> INCOMPLETE); agents not yet adopted | 04 | IN_PROGRESS |  |  |
| M04-13 | Verdict vocabulary | INCOMPLETE | spec vocabulary + mapping in packages/types/src/platform/verdict.ts (UNAVAILABLE -> INCOMPLETE); agents not yet adopted | 04 | IN_PROGRESS |  |  |
| M04-14 | Verdict vocabulary | BLOCKING | spec vocabulary + mapping in packages/types/src/platform/verdict.ts (UNAVAILABLE -> INCOMPLETE); agents not yet adopted | 04 | IN_PROGRESS |  |  |
| A01 | The 12 specialist agents | Signal Integrity Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A02 | The 12 specialist agents | Instrument Validation Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A03 | The 12 specialist agents | Market Context Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A04 | The 12 specialist agents | Technical Structure Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A05 | The 12 specialist agents | Price Action Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A06 | The 12 specialist agents | News & Sentiment Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A07 | The 12 specialist agents | Liquidity Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A08 | The 12 specialist agents | Historical Pattern Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A09 | The 12 specialist agents | Calendar & Macro Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A10 | The 12 specialist agents | Index Constituents Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A11 | The 12 specialist agents | Independent Challenger Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references (rule-based, no LLM; shadow only) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A12 | The 12 specialist agents | Research Synthesis Agent: contract, evidence references, reasoning summary, risk flags, execution status, unavailable-state handling | agent_evidence_references | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| A13 | Additional agent | options-risk-v1: preserve and map (not in the spec's 12) | options-risk-v1 (rule-based; needs option data) | 04 | NOT_STARTED |  |  |

## M05 — Market Intelligence & Regime Detection

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M05-01 | Required functionality | Trending market detection. | pure detector risk/src/regime/detect.ts (needs bars) / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M05-02 | Required functionality | Range-bound market detection. | risk/src/regime/detect.ts / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M05-03 | Required functionality | Volatile market detection. | risk/src/regime/detect.ts (HIGH/LOW_VOLATILITY) / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M05-04 | Required functionality | Risk-off market detection. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-05 | Required functionality | Bullish and bearish market assessment. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-06 | Required functionality | Volatility regime detection. | risk/src/regime/detect.ts / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M05-07 | Required functionality | Implied volatility analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-08 | Required functionality | Event-risk assessment. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-09 | Required functionality | Multi-timeframe analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-10 | Required functionality | 5-minute analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-11 | Required functionality | 15-minute analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-12 | Required functionality | 1-hour analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-13 | Required functionality | Market structure. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |
| M05-14 | Required functionality | Correlated index exposure. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 04 | NOT_STARTED |  |  |

## M06 — Channel Strategy Learning Engine

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M06-01 | Required functionality | Identify entry style. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-02 | Required functionality | Identify CE / PE preference. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-03 | Required functionality | Identify strike-distance preference. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-04 | Required functionality | Identify preferred trading times. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-05 | Required functionality | Identify market conditions used by the channel. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-06 | Required functionality | Detect recurring strategy clusters. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-07 | Required functionality | Identify breakout strategies. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-08 | Required functionality | Identify reversal strategies. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-09 | Required functionality | Identify momentum strategies. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-10 | Required functionality | Identify gap strategies. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-11 | Required functionality | Identify scalping strategies. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-12 | Required functionality | Infer entry rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-13 | Required functionality | Infer exit rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-14 | Required functionality | Infer stop-loss rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-15 | Required functionality | Infer target rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-16 | Required functionality | Infer risk behaviour. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-17 | Channel performance intelligence | Conditional win rates. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-18 | Channel performance intelligence | Historical profitability. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-19 | Channel performance intelligence | Best market conditions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-20 | Channel performance intelligence | Worst market conditions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-21 | Channel performance intelligence | Performance by time of day. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-22 | Channel performance intelligence | Performance by instrument. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-23 | Channel performance intelligence | Performance by market regime. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-24 | Channel performance intelligence | Strategy confidence. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-25 | Channel performance intelligence | Strategy classification. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-26 | Channel performance intelligence | Playbook generation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-27 | Channel playbook | Strategy description. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-28 | Channel playbook | Entry context. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-29 | Channel playbook | Entry rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-30 | Channel playbook | Exit rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-31 | Channel playbook | Stop-loss behaviour. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-32 | Channel playbook | Target behaviour. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-33 | Channel playbook | Risk rules. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-34 | Channel playbook | Preferred instruments. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-35 | Channel playbook | Preferred market regimes. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-36 | Channel playbook | Historical performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-37 | Channel playbook | Sample size. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-38 | Channel playbook | Confidence and limitations. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M06-39 | Channel playbook | Version history. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |

## M07 — Strategy Intelligence & Learning Database

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M07-01 | Required functionality | Strategy inference. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-02 | Required functionality | Pattern-to-outcome mapping. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-03 | Required functionality | Outcome-reason analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-04 | Required functionality | Conditional win rates. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-05 | Required functionality | Evidence chain. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-06 | Required functionality | Playbook versioning. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-07 | Required functionality | Performance tracking. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-08 | Required functionality | Strategy rollback. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-09 | Required functionality | Strategy drift detection. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-10 | Required functionality | Strategy degradation alerts. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-11 | Required functionality | Source profiles. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-12 | Required functionality | Regime-specific performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-13 | Required functionality | Time-specific performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-14 | Required functionality | Instrument-specific performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-15 | Required functionality | Stop-loss behaviour analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-16 | Required functionality | Signal revision and staleness analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |
| M07-17 | Required functionality | Counterfactual review. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 03 | NOT_STARTED |  |  |

## M08 — Capital Management & Position Sizing

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M08-01 | User-specific information | Total trading capital. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-02 | User-specific information | Available capital. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-03 | User-specific information | Risk percentage. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-04 | User-specific information | Maximum risk per trade. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-05 | User-specific information | Maximum daily loss. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-06 | User-specific information | Maximum concurrent positions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-07 | User-specific information | Trading budget. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-08 | User-specific information | Preferred instruments. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-09 | User-specific information | User permissions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-10 | User-specific information | Broker account reference. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-11 | Calculations | Maximum permissible trade risk. | sizing engine (single configured capital) / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-12 | Calculations | Risk per lot. | sizing engine / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-13 | Calculations | Number of lots. | sizing engine / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-14 | Calculations | Expected profit. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-15 | Calculations | Expected loss. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-16 | Calculations | Risk-to-reward ratio. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-17 | Calculations | Break-even price. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-18 | Calculations | Capital utilisation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-19 | Calculations | Portfolio exposure. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M08-20 | Calculations | Remaining daily risk capacity. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |

## M09 — Confidence Scoring & Signal Strength

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M09-01 | Required inputs | Agent assessments. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-02 | Required inputs | Historical outcomes. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-03 | Required inputs | Market regime. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-04 | Required inputs | Technical structure. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-05 | Required inputs | Price action. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-06 | Required inputs | News and sentiment. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-07 | Required inputs | Liquidity. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-08 | Required inputs | Pattern similarity. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-09 | Required inputs | Risk flags. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-10 | Required inputs | Evidence completeness. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-11 | Required inputs | Data freshness. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-12 | Required inputs | Strategy reliability. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-13 | Required outputs | Overall confidence score. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-14 | Required outputs | Supporting evidence. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-15 | Required outputs | Contradicting evidence. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-16 | Required outputs | Missing evidence. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-17 | Required outputs | Risk flags. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-18 | Required outputs | Historical comparison. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-19 | Required outputs | Confidence explanation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M09-20 | Required outputs | Calibration status. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |

## M10 — Risk Management & Capital Protection

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M10-01 | Required controls | Maximum risk per trade. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-02 | Required controls | Stop-loss validation. | packages/stop-loss + mandatory stop rule / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-03 | Required controls | Maximum loss per trade. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-04 | Required controls | Maximum daily loss. | loss circuit breakers / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-05 | Required controls | Portfolio exposure. | portfolio open-risk limits / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-06 | Required controls | Maximum concurrent positions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-07 | Required controls | Correlated index exposure. | risk/src/correlation / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-08 | Required controls | Event-risk restrictions. | risk/src/market/windows.ts blackout windows / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-09 | Required controls | Drawdown controls. | risk/src/drawdown governor / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-10 | Required controls | High-volatility restrictions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-11 | Required controls | Low-liquidity restrictions. | risk/src/liquidity / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-12 | Required controls | Market closing-time restrictions. | risk/src/market/sessions.ts / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-13 | Required controls | Maximum lot limits. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-14 | Required controls | Minimum risk-to-reward requirements. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-15 | Required controls | Daily loss halt. | circuit breakers / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-16 | Required controls | Drawdown halt. | drawdown governor / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-17 | Required controls | Adaptive risk reduction. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-18 | Required controls | Correlation controls. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-19 | Required controls | Optional research-only Kelly analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-20 | Kill switches | Global kill switch. | packages/runtime-state kill switch + safety-control CLI / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M10-21 | Kill switches | Per-market kill switch. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-22 | Kill switches | Per-source kill switch. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-23 | Kill switches | Per-strategy kill switch. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-24 | Kill switches | Daily-loss kill switch. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M10-25 | Kill switches | Drawdown kill switch. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |

## M11 — Pre-Trade What-If Simulator

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M11-01 | Required functionality | Stop-loss loss calculation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-02 | Required functionality | Target profit calculation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-03 | Required functionality | Break-even calculation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-04 | Required functionality | Implied-move analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-05 | Required functionality | Gap-risk analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-06 | Required functionality | Portfolio impact. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-07 | Required functionality | Multiple-lot simulation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-08 | Required functionality | Different entry-price comparison. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-09 | Required functionality | Different stop-loss comparison. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-10 | Required functionality | Risk-to-reward comparison. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-11 | Required functionality | Cost and slippage estimation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |
| M11-12 | Required functionality | Scenario comparison. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 06 | NOT_STARTED |  |  |

## M12 — Decision Engine & Explainable Decisions

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M12-01 | Decision outcomes | QUALIFIED | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-02 | Decision outcomes | WAIT | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-03 | Decision outcomes | REJECT | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-04 | Decision outcomes | EVALUATION_ONLY | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-05 | Decision outcomes | NO_TRADE | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-06 | Decision outcomes | PENDING | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-07 | Decision outcomes | APPROVED | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS | DB constraint APPROVED requires QUALIFIED + guard trigger verified in CI run 42445765317 (workflow engine itself not built) |  |
| M12-08 | Decision outcomes | REJECTED | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-09 | Decision outcomes | EXPIRED | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-10 | Decision outcomes | SUPERSEDED | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-11 | Decision outcomes | CANCELLED | vocabulary + legal transitions in packages/types/src/platform/decision.ts; database column and engine not yet built / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IN_PROGRESS |  |  |
| M12-12 | Required functionality | Evidence-based decision. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-13 | Required functionality | Research synthesis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-14 | Required functionality | Risk validation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-15 | Required functionality | User-specific eligibility. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-16 | Required functionality | Decision validity window. | 15-minute approval validity (TWINS_RISK_EXPIRY_APPROVED_MINUTES) / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M12-17 | Required functionality | Signal cancellation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-18 | Required functionality | Revalidation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-19 | Required functionality | Stale-decision detection. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-20 | Required functionality | Contradiction handling. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-21 | Required functionality | Human-readable explanation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-22 | Explainable decision package | Why it qualified. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-23 | Explainable decision package | Why it did not qualify. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-24 | Explainable decision package | Why a larger position was not permitted. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-25 | Explainable decision package | What evidence supports it. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-26 | Explainable decision package | What risks remain. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-27 | Explainable decision package | What would invalidate it. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-28 | Explainable decision package | Which historical patterns are comparable. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M12-29 | Explainable decision package | Which agents agreed or disagreed. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |

## M13 — Human Approval & Execution

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M13-01 | Approval interface | Telegram approval bot. | services/approval-bot (inactive on staging) / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-02 | Approval interface | Approval cards. | risk_approval_cards / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-03 | Approval interface | Signal summary. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-04 | Approval interface | Evidence summary. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-05 | Approval interface | Confidence assessment. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-06 | Approval interface | Risk assessment. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-07 | Approval interface | Suggested quantity. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-08 | Approval interface | Entry, SL and target. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-09 | Approval interface | Approve / reject / watch actions. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-10 | Approval interface | Approval expiry. | risk expiry + card expiry / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-11 | Approval interface | Eligibility recheck. | assessApprovalEligibility + twins_record_risk_approval / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-12 | Three execution modes | Mode A — Paper Trading: Simulated order placement. | packages/paper (off by default) / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-13 | Three execution modes | Mode A — Paper Trading: Simulated fills. | packages/paper manager / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-14 | Three execution modes | Mode A — Paper Trading: Simulated trade lifecycle. | paper_trade_events / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-15 | Three execution modes | Mode A — Paper Trading: P&L calculation. | packages/paper/src/pnl.ts / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-16 | Three execution modes | Mode A — Paper Trading: Trade history. | paper_outcomes; GET /paper/outcomes / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-17 | Three execution modes | Mode A — Paper Trading: No real money. | LIVE_TRADING guard; paper never calls a broker / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M13-18 | Three execution modes | Mode B — Assisted Live: User reviews the proposed order. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-19 | Three execution modes | Mode B — Assisted Live: User explicitly confirms each live order. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-20 | Three execution modes | Mode B — Assisted Live: System rechecks risk and eligibility. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-21 | Three execution modes | Mode B — Assisted Live: Broker adapter executes only after valid authorisation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-22 | Three execution modes | Mode B — Assisted Live: Order and fill status are reconciled. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-23 | Three execution modes | Mode C — Controlled Auto: Explicitly authorised automation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-24 | Three execution modes | Mode C — Controlled Auto: Pre-approved strategy and risk policy. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-25 | Three execution modes | Mode C — Controlled Auto: Strict capital and quantity limits. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-26 | Three execution modes | Mode C — Controlled Auto: Kill switches. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-27 | Three execution modes | Mode C — Controlled Auto: Order monitoring. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-28 | Three execution modes | Mode C — Controlled Auto: Emergency stop. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M13-29 | Three execution modes | Mode C — Controlled Auto: Complete audit trail. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |

## M14 — Trade Management & Monitoring

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M14-01 | Required functionality | Entry tracking. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M14-02 | Required functionality | Live P&L. | paper pnl (paper only) / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-03 | Required functionality | Stop-loss monitoring. | paper manager (paper only) / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-04 | Required functionality | Target monitoring. | paper manager (paper only) / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-05 | Required functionality | Trailing stop. | paper adaptiveManagement / trail config / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-06 | Required functionality | Time-based exit. | paper square-off time / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-07 | Required functionality | Risk breach alerts. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M14-08 | Required functionality | Stop-loss-hit status. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M14-09 | Required functionality | Target-hit status. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M14-10 | Required functionality | Partial exit handling. | paper exit fractions / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-11 | Required functionality | Trade status. | paper trade states / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| M14-12 | Required functionality | Position reconciliation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | NOT_STARTED |  |  |
| M14-13 | Required functionality | Outcome recording. | paper_outcomes / schema in migration 0033 (written, not yet applied or integration-tested) | 07 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |

## M15 — Outcome Learning & Performance Analytics

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M15-01 | Required analytics | Actual versus predicted results. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-02 | Required analytics | Outcome reasons. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-03 | Required analytics | Channel performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-04 | Required analytics | Pattern performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-05 | Required analytics | Strategy performance. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-06 | Required analytics | Confidence calibration. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-07 | Required analytics | Agent contribution. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-08 | Required analytics | Entry timing quality. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-09 | Required analytics | Stop-loss quality. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-10 | Required analytics | Target quality. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-11 | Required analytics | Exit quality. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-12 | Required analytics | Verdict accuracy. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-13 | Required analytics | Strategy attribution. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-14 | Required analytics | Source-confidence adjustment. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |
| M15-15 | Required analytics | Historical performance trends. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 08 | NOT_STARTED |  |  |

## M16 — Independent Opportunity Engine

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| M16-01 | Required functionality | Independent market scanning. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-02 | Required functionality | Pattern detection. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-03 | Required functionality | Market-regime analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-04 | Required functionality | Technical setup detection. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-05 | Required functionality | Price-action confluence. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-06 | Required functionality | Macro and calendar analysis. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-07 | Required functionality | Historical pattern matching. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-08 | Required functionality | Risk-to-reward screening. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-09 | Required functionality | Candidate generation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-10 | Required functionality | Candidate ranking. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-11 | Required functionality | Opportunity evidence creation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-12 | Required functionality | Candidate expiry. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |
| M16-13 | Required functionality | Revalidation. | none identified in the Phase 00 audit / schema in migration 0033 (written, not yet applied or integration-tested) | 05 | NOT_STARTED |  |  |

## MU — Multi-user architecture (Part 4)

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| MU-01 | Part 4 | Separate account | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-02 | Part 4 | Secure authentication | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-03 | Part 4 | Individual capital | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-04 | Part 4 | Individual available balance | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-05 | Part 4 | Individual risk percentage | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-06 | Part 4 | Individual daily loss limit | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-07 | Part 4 | Individual position limits | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-08 | Part 4 | Individual trading permissions | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-09 | Part 4 | Individual broker connection | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS |  |  |
| MU-10 | Part 4 | Individual approval settings | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | NOT_STARTED |  |  |
| MU-11 | Part 4 | Individual portfolio | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | NOT_STARTED |  |  |
| MU-12 | Part 4 | Individual trade history | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | NOT_STARTED |  |  |
| MU-13 | Part 4 | Individual analytics | none identified in the Phase 00 audit (single shared API key; user_id only on accounts and broker_connections) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | NOT_STARTED |  |  |
| MU-14 | Part 4 | Isolation: no user can view another user's private broker details | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |
| MU-15 | Part 4 | Isolation: no user can access another user's capital | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |
| MU-16 | Part 4 | Isolation: no user can approve another user's trade | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |
| MU-17 | Part 4 | Isolation: no user can modify another user's risk settings | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |
| MU-18 | Part 4 | Isolation: no user can view another user's private trade history | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |
| MU-19 | Part 4 | Authorisation checks at API, service and database-access boundaries (not frontend-only) | authorize()/ownerScope() + isolation tests (pure); credentials helpers; DB enforcement pending (Stage 02) / schema in migration 0033 (written, not yet applied or integration-tested) | 01-02 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |

## UI — Frontend screens (Part 5.4)

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| S01 | Screens | Login and authentication: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S02 | Screens | Main dashboard: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S03 | Screens | Market overview: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S04 | Screens | Telegram channels: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S05 | Screens | Signal intake: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S06 | Screens | Signal details: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S07 | Screens | Signal history: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S08 | Screens | Evidence explorer: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S09 | Screens | Research workspace: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S10 | Screens | Agent intelligence: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S11 | Screens | Channel strategy intelligence: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S12 | Screens | Strategy playbooks: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S13 | Screens | Independent opportunities: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S14 | Screens | Decision centre: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S15 | Screens | Decision detail: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S16 | Screens | Risk dashboard: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S17 | Screens | Capital management: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S18 | Screens | What-if simulator: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S19 | Screens | Approval centre: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S20 | Screens | Paper trading: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S21 | Screens | Live execution controls: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S22 | Screens | Orders and fills: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S23 | Screens | Open positions: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S24 | Screens | Trade monitoring: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S25 | Screens | P&L and analytics: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S26 | Screens | Learning and performance: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S27 | Screens | Notifications: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S28 | Screens | User settings: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S29 | Screens | Broker settings: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |
| S30 | Screens | Administration and audit: real backend contract plus loading, empty, error, stale-data and permission states | see frontend audit | 09 | NOT_STARTED |  |  |

## PF — Platform foundation (Phase 01)

| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |
|---|---|---|---|---|---|---|---|
| P01 | Foundation | Domain architecture and module boundaries | docs/product/ARCHITECTURE_DECISIONS.md (ADR-001..009) + BASELINE_PRESERVATION_MAP.md | 01 | IMPLEMENTED | docs reviewed against repo (Stage 00) |  |
| P02 | Foundation | Shared data contracts | packages/types/src/platform (ids, errors, auth, decision, verdict, opportunity, execution, aiGateway) | 01 | IMPLEMENTED | tests/unit/platform/contracts.test.ts + credentials.test.ts pass (local run 2026-11-08) |  |
| P03 | Foundation | Event contracts | packages/types/src/platform/events.ts (envelope + 31 event types, user-scoping rule) | 01 | IMPLEMENTED | tests/unit/platform/contracts.test.ts + credentials.test.ts pass (local run 2026-11-08) |  |
| P04 | Foundation | API contracts | docs/product/API_CONTRACTS.md: conventions only; per-route contracts follow each stage | 01 | IN_PROGRESS |  |  |
| P05 | Foundation | Database ownership and relationships | ADR-002/011/012 + migration 0033 applied and integration-tested in CI + withUser helper | 01 | VERIFIED | tests/unit/database/masterBuildMigration.test.ts (static rules) pass; migration not applied (no database available locally); CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) |  |
| P06 | Foundation | Authentication and authorisation | pure authorize()/hasPermission() + scrypt/session helpers (packages/shared/src/credentials.ts); no DB sessions, login route or middleware yet | 01 | IN_PROGRESS |  |  |
| P07 | Foundation | User isolation | isolation rules tested as pure functions + row-level security policies written in migration 0033 (unapplied); no route or service uses them yet | 01 | IN_PROGRESS | CI run 42445765317 on 2584bd6 (feat/master-build): all jobs green; migration 0033 applied on Postgres 16 (34 migrations recorded); tests/integration/database/masterBuildPlatform.test.ts 11 tests pass (RLS via unprivileged role, owner-tied FKs, decision guard, live-mode lock, append-only, mandatory-stop floor) (database layer only; API and service layers still to do, so not VERIFIED) |  |
| P08 | Foundation | Configuration management | packages/config + env guards | 01 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| P09 | Foundation | Audit logging | audit_events + 32 hash chains + verifier | 01 | IMPLEMENTED | Phase 00 audit: unit suite 197 files / 3,451 tests pass (local run 2026-11-08); hosted CI (incl. integration) green on 507c6f5 |  |
| P10 | Foundation | Error handling | packages/types/src/platform/errors.ts (taxonomy, safe bodies, no existence leak) | 01 | IMPLEMENTED | tests/unit/platform/contracts.test.ts + credentials.test.ts pass (local run 2026-11-08) |  |
| P11 | Foundation | Background-job conventions | packages/types/src/platform/jobs.ts (queues, idempotency keys, retry policy, execution never retried) | 01 | IMPLEMENTED | tests/unit/platform/contracts.test.ts + credentials.test.ts pass (local run 2026-11-08) |  |
| P12 | Foundation | AI provider interface | aiGateway contracts (Untrusted, parseStructured, routes, usage, provenance); no provider adapter | 01 | IN_PROGRESS |  |  |
| P13 | Foundation | Execution safety boundaries | LIVE_TRADING guard in every process + order-intent guard (existing) + checkExecutionGate (new, tested) | 01 | IMPLEMENTED | tests/unit/platform/contracts.test.ts + credentials.test.ts pass (local run 2026-11-08) |  |
