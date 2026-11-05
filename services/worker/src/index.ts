/**
 * TWINS background worker — BullMQ consumer (spec section 46).
 *
 * Consumes jobs from Redis queues and runs the data-ingestion + validation
 * pipeline. Two queues are active:
 *
 *   signal_queue   — Telegram message ingestion → signal extraction →
 *                    market context refresh → validation pipeline
 *   market_queue   — standalone market-bar ingestion (driven by scheduler)
 *
 * Safety invariants (spec section 2/45/47):
 * - The shared live-trading guard (@twins/config) runs first; the process exits if live trading is configured.
 * - All database writes go through Drizzle (PostgreSQL is the source of
 *   record; Redis is ephemeral queue transport only, spec section 47).
 * - A failed job is recorded in the `jobs` table (via runIngestionJob) and
 *   moved to the BullMQ dead-letter queue; errors are never silently swallowed.
 * - Idempotency: duplicate Telegram updates carry the same BullMQ job ID
 *   (set by the API) and are rejected at the queue level before reaching
 *   this handler. Storage-level deduplication (telegram_messages unique
 *   index) is the backstop.
 */

import { UnrecoverableError, Queue, Worker, type Job } from "bullmq";
import { assertIntakeEnabled, configureRuntimeState, pgStateSource, SafetyRefusalError } from "@twins/runtime-state";
import { loadStopLossConfig } from "@twins/stop-loss";
import { enforceRuntimeRoleSeparation } from "@twins/audit-chain";
import { runResearchProbe } from "@twins/risk";
import { alerterFromEnv, observe, recordProcessStart, type Alerter } from "@twins/alerting";
import { createDefaultRegistry, createRunObserver, loadObservabilityConfig, logProviderAvailability, observeConfigLoad, createProductionRegistry, historicalDatasetReference, loadAgentEngineConfig, loadAgentRulesConfig, resolveCalendarMacroProviders, resolveHistoricalProviders, resolveInstrumentReference, resolveNewsConstituentProviders, resolveOhlcProviders, resolveQuoteProviders, runAgentEngine, runAgentEngineShadow } from "@twins/agents";
import { createPendingRiskDecisionForOptionsClaim, createPendingRiskDecisionForSignal, recordIntelligenceForOptionsClaim, recordIntelligenceForSignal, RiskDecisionError, sizeLatestRiskDecisionForOptionsClaim, sizeLatestRiskDecisionForSignal, evaluatePortfolioRisk, evaluateMarketRisk, type MarketAlert, type MarketDataProvider } from "@twins/risk";
import { withIntakeGate } from "./safetyGate.js";
import { processOutboxQueueJob, startOutboxReconciler, type OutboxJobPayload } from "./outbox.js";
import { Redis } from "ioredis";
import { describeErrorSafely, type StructuredLogger } from "@twins/shared";
import { buildJobLogContext } from "./correlationLog.js";
import { InvalidJobInputError, ReconciliationRequiredError } from "./jobErrors.js";
import { parseJobTimestamp } from "./jobTimestamp.js";
import { parseCapture, processTelegramEventsJob, type CapturePayload, type TelegramEventsJobPayload } from "./telegramEvents.js";
import { randomUUID } from "node:crypto";
import { enforceLiveTradingGuard, loadConfig } from "@twins/config";
import { createBoundedDb, type Db } from "@twins/database";
import {
  getRevisionStates,
  ingestMarketBars,
  ingestTelegramMessages,
  recordCaptureEvent,
  resolveTelegramSource,
  runIngestionJob,
} from "@twins/ingestion";
import { analyzeTelegramText, assessOptionsClaim, createManualReferenceContractMaster, createProviderSnapshotContractMaster, parseProviderSnapshotFile, createSignalFromTelegramMessage, parseManualReferenceFile, recordOptionsIntake, unconfiguredContractMaster, unavailablePremiumProvider, TELEGRAM_PARSER_VERSION, type OptionsContractMaster } from "@twins/signals";
import { readFileSync } from "node:fs";
import { findValidationByKey, validateSignal } from "@twins/decision-intelligence";
import {
  marketDataProviders,
  YahooFinanceAdapter,
  YAHOO_PROVIDER_NAME,
} from "@twins/adapter-market";
import {
  telegramProviders,
  TelegramBotWebhookAdapter,
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  chatIdOfQueuedMessage,
  textSha256Hex,
  USER_CAPTURE_PROVIDER_NAME,
  loadTelegramIntakePolicy,
  type NormalizedTelegramMessage,
  type TelegramIntakePolicy,
} from "@twins/adapter-telegram";
import type { MarketBarRequest } from "@twins/types";

// ─── Config & safety gate ──────────────────────────────────────────────────

enforceLiveTradingGuard("worker");
const config = loadConfig();

// Standard process logger: JSON lines plus alerts for the events in the alert policy (docs/twins/OPERATIONAL_ALERTING.md).
const observed = observe("worker");

console.log(
  `[worker] starting appEnv=${config.appEnv} tradingMode=${config.tradingMode} liveTradingEnabled=${config.liveTradingEnabled}`,
);

// ─── Process-owned bounded database lifecycle (audit REL-01 / CORE-01) ─────
// Bounded connection pool sized for worker concurrency (2 signal + 4 market + headroom).
// Dedicated close() drains the pool gracefully on shutdown.
export const workerDb = createBoundedDb({
  max: 10,
  idleTimeoutMillis: 30000,
});

// ─── Runtime safety state (Stage 1 / Task 2) ───────────────────────────────
// Every critical loop reads the database-backed controls (kill switch, intake, trading) through this one per-process instance. Fail closed:
// an unreadable state refuses. Not configured under NODE_ENV=test, where the vitest setup installs an explicit test source instead.
if (process.env["NODE_ENV"] !== "test") {
  configureRuntimeState({ source: pgStateSource(workerDb.pool), logger: observed.logger });
  // Role separation (Stage 1 / Task 3): outside local development the worker must run as the least-privilege role, or it refuses to start (exit 82).
  if (config.appEnv !== "development") await enforceRuntimeRoleSeparation("worker", workerDb.pool);
  // P0 hardening (HB-03 / HB-04): the research-assessment check needs read access to the agent tables and a database engine flag that agrees with TWINS_AGENT_ENGINE_ENABLED. When the check applies
  // a missing grant or a mismatch stops the process here (fail closed) instead of failing per request or being skipped.
  await runResearchProbe(workerDb.db, observed.logger);
}

// ─── Register concrete adapters ────────────────────────────────────────────

marketDataProviders.register(YAHOO_PROVIDER_NAME, new YahooFinanceAdapter());
telegramProviders.register(
  TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME,
  new TelegramBotWebhookAdapter(),
);

// ─── Job-payload types (must match what the API / scheduler enqueues) ──────

export interface TelegramJobPayload {
  jobType: "telegram_messages";
  providerName: string;
  /**
   * End-to-end correlation LOG metadata minted at intake. Optional: jobs queued before this field
   * existed have none and are processed normally (a worker-generated id is used and flagged).
   * Never a deduplication key.
   */
  correlation?: { correlationId: string; requestId: string; receivedAt: string };
  telegram: {
    params: { channelIdentifier: string; sinceExternalMessageId?: string };
    /** Already-normalized message passed from the webhook handler to avoid a
     *  second Telegram API call. If absent the worker would call fetchMessages()
     *  but since we use a webhook-driven adapter that throws on fetchMessages(),
     *  this field is always required for telegram jobs. */
    normalizedMessage: NormalizedTelegramMessage;
    exchange: string;
    instrumentType: string;
    /**
     * Provenance of a read-only User API capture (live or history). ABSENT on the original Bot API webhook jobs, which
     * follow their existing path unchanged.
     */
    capture?: CapturePayload;
  };
}

export interface MarketBarsJobPayload {
  jobType: "market_bars";
  providerName: string;
  market: {
    request: { instrument: { symbol: string; exchange: string }; timeframe: string; from: string; to: string };
    instrumentType: string;
    maxStalenessMs?: number;
  };
}

/** Everything the signal queue can carry: message jobs (Bot API or User API capture) and observed-deletion event jobs. */
export type SignalQueueJobPayload = TelegramJobPayload | TelegramEventsJobPayload | OutboxJobPayload;
export type WorkerJobPayload = SignalQueueJobPayload | MarketBarsJobPayload;

// ─── Queue boundary ────────────────────────────────────────────────────────

/**
 * Queue-processing boundary for telegram jobs. Only permanent invalid input
 * (InvalidJobInputError) is translated into BullMQ's UnrecoverableError, which
 * fails the job immediately without consuming remaining attempts. Every other
 * error propagates unchanged so normal attempts/backoff apply. The message
 * carries only the job id and external message id - no payload or secrets.
 */
export interface TelegramJobOptions {
  /** Durable-intake retry backoff (tests inject a fast policy; production uses the default). */
  outboxRetryPolicy?: { baseMs: number; maxMs: number };
  /** Contract master for options assessments (tests inject one). Default: the explicitly configured one, else NONE. */
  optionsMaster?: OptionsContractMaster;
  /** Structured logger (tests inject a capture sink). Defaults to JSON lines on the console. */
  logger?: StructuredLogger;
  /**
   * Which chats may be ingested and whether only options messages may proceed. Default: the policy read from
   * TWINS_TELEGRAM_ALLOWED_CHAT_IDS / TWINS_TELEGRAM_OPTIONS_ONLY at startup (missing/empty = NO chat approved).
   * Tests inject an explicit policy.
   */
  intakePolicy?: Pick<TelegramIntakePolicy, "isChatApproved" | "optionsOnly">;
  /**
   * Which market bars the validation analyses. Default (and the only production behaviour): the Yahoo daily bars this worker just
   * refreshed - never synthetic rows. Tests that run the pipeline on SYNTHETIC bars name that source and context explicitly,
   * so they do not depend on whatever real bars happen to be in the database (which age out of the freshness window).
   */
  analysisMarket?: { source: string; timeframe: string; context?: "analysis" | "synthetic" };
}

export type TelegramJobOutcomeKind =
  | "validation_created"
  | "validation_already_existed"
  | "no_signal"
  | "ambiguous_message_no_signal"
  | "options_claim_not_ingested"
  | "rejected_data_quality"
  | "message_row_missing"
  /** The queued message's chat is not on the approved list: nothing was written or started. */
  | "chat_not_approved"
  /** Options-only mode: the message is not an options message: nothing was written or started. */
  | "non_options_blocked";

export interface TelegramJobOutcome {
  outcome: TelegramJobOutcomeKind;
  signalId?: string;
  validationId?: string;
  /** Reason codes of an unsupported/unverified options intake (codes only; the raw message stays in telegram_messages). */
  reasonCodes?: string[];
  /** The options_claims row recorded (or found, on a retry) for this message and parser version. */
  optionsClaimId?: string;
}

/**
 * Options assessments use NO contract master (and no premium provider) unless one is explicitly configured:
 * TWINS_OPTIONS_MANUAL_REFERENCE=<path to a manual-format reference file>. A configured but malformed file fails at
 * startup (fail-closed). The CLI's sample/manual reference files are never attached implicitly.
 */
const optionsReferencePath = process.env["TWINS_OPTIONS_MANUAL_REFERENCE"];
const optionsProviderSnapshotPath = process.env["TWINS_OPTIONS_PROVIDER_SNAPSHOT"];
if (optionsReferencePath && optionsProviderSnapshotPath) {
  throw new Error("TWINS_OPTIONS_MANUAL_REFERENCE and TWINS_OPTIONS_PROVIDER_SNAPSHOT are both set; configure exactly one (references are never merged or silently chosen)");
}
// An imported provider snapshot (provider-listed only) is enabled ONLY by TWINS_OPTIONS_PROVIDER_SNAPSHOT; never by default.
export const configuredOptionsMaster: OptionsContractMaster | null = optionsReferencePath
  ? createManualReferenceContractMaster(parseManualReferenceFile(JSON.parse(readFileSync(optionsReferencePath, "utf8"))))
  : optionsProviderSnapshotPath
    ? createProviderSnapshotContractMaster(parseProviderSnapshotFile(JSON.parse(readFileSync(optionsProviderSnapshotPath, "utf8"))))
    : null;

const defaultWorkerLogger = observed.logger;

/** Mandatory stop-loss sanity bounds (TWINS_STOPLOSS_MAX_RISK_PCT_*); a malformed override makes the worker refuse to start. */
const stopLossConfig = loadStopLossConfig();

/**
 * Fail-closed intake policy for this process: TWINS_TELEGRAM_ALLOWED_CHAT_IDS (missing/empty approves NO chat; malformed
 * throws here, so the worker does not start) and TWINS_TELEGRAM_OPTIONS_ONLY ("true"/"false"; anything else throws).
 */
const defaultIntakePolicy: Pick<TelegramIntakePolicy, "isChatApproved" | "optionsOnly"> = loadTelegramIntakePolicy();

export async function processTelegramQueueJob(
  job: Job<TelegramJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<void> {
  // Runtime safety boundary: before ANYTHING is read, written or logged as started. A refusal is not a job failure (see safetyGate.ts).
  await assertIntakeEnabled("worker.telegram_job");
  const log = (options.logger ?? defaultWorkerLogger).child(buildJobLogContext(job, correlationId));
  const startedAt = Date.now();
  log.info("worker.job.started");
  try {
    const result = await processTelegramJob(job, correlationId, db, {
      logger: log,
      ...(options.intakePolicy ? { intakePolicy: options.intakePolicy } : {}),
      ...(options.analysisMarket ? { analysisMarket: options.analysisMarket } : {}),
    });
    log.info("worker.job.completed", { ...result, durationMs: Date.now() - startedAt });
  } catch (err) {
    const permanent = err instanceof ReconciliationRequiredError || err instanceof InvalidJobInputError;
    // Safe diagnostics only (code + class name); the error message is never logged.
    log.error("worker.job.failed", { ...describeErrorSafely(err), retryable: !permanent, durationMs: Date.now() - startedAt });
    if (err instanceof ReconciliationRequiredError) {
      throw new UnrecoverableError(
        `${err.message} (reconciliation required; jobId=${job.id ?? "unknown"})`,
      );
    }
    if (err instanceof InvalidJobInputError) {
      const messageId = job.data?.telegram?.normalizedMessage?.externalMessageId ?? "unknown";
      throw new UnrecoverableError(
        `${err.message} (permanent invalid input; jobId=${job.id ?? "unknown"} externalMessageId=${messageId})`,
      );
    }
    throw err;
  }
}

/**
 * Queue boundary for observed-deletion event jobs (User API capture). Same log context and error mapping as message jobs:
 * only permanent invalid input becomes an UnrecoverableError; everything else propagates for the normal attempts/backoff.
 */
export async function processTelegramEventsQueueJob(
  job: Job<TelegramEventsJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<void> {
  await assertIntakeEnabled("worker.telegram_events_job");
  const log = (options.logger ?? defaultWorkerLogger).child(buildJobLogContext(job, correlationId));
  const startedAt = Date.now();
  log.info("worker.job.started");
  try {
    const result = await processTelegramEventsJob(job.data, db, { logger: log, intakePolicy: options.intakePolicy ?? defaultIntakePolicy });
    log.info("worker.job.completed", { ...result, durationMs: Date.now() - startedAt });
  } catch (err) {
    const permanent = err instanceof InvalidJobInputError;
    log.error("worker.job.failed", { ...describeErrorSafely(err), retryable: !permanent, durationMs: Date.now() - startedAt });
    if (err instanceof InvalidJobInputError) {
      throw new UnrecoverableError(`${err.message} (permanent invalid input; jobId=${job.id ?? "unknown"})`);
    }
    throw err;
  }
}

/**
 * The signal queue handler: ONLY `jobType: "telegram_events"` goes to the events handler; every other payload (all existing
 * jobs, including legacy ones) takes the unchanged message path.
 */
export async function processSignalQueueJob(
  job: Job<SignalQueueJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<void> {
  const data = job.data as { jobType?: unknown } | undefined;
  if (data?.jobType === "telegram_outbox") {
    // Durable intake (Stage 2 / Task 2): the job carries only the outbox row id. Jobs queued before this change keep their full payload and take the paths below.
    await processOutboxQueueJob(job as unknown as Job<OutboxJobPayload>, db, {
      logger: options.logger ?? defaultWorkerLogger,
      ...(options.outboxRetryPolicy ? { retryPolicy: options.outboxRetryPolicy } : {}),
      runPipeline: (pseudoJob) => processSignalQueueJob(pseudoJob as Job<SignalQueueJobPayload>, correlationId, db, options),
    });
    return;
  }
  if (data?.jobType === "telegram_events") {
    return processTelegramEventsQueueJob(job as Job<TelegramEventsJobPayload>, correlationId, db, options);
  }
  return processTelegramQueueJob(job as Job<TelegramJobPayload>, correlationId, db, options);
}


/**
 * Stage 3 / Task 1: the first (PENDING) risk decision for a validated signal or a recorded options claim. Nothing is sized, limited or sent for approval
 * here. Fail closed: a database or runtime-state error propagates (the intake outbox retries; the creation is idempotent per subject). A safety refusal
 * keeps its identity so the intake gate pauses the job instead of consuming an attempt.
 */
/**
 * The market-data seam for the market-risk gates (Stage 3 / Task 5). NO live market-data provider exists (Zerodha / vendor feeds are out of scope), so this is
 * unset in every real process: a portfolio-passed decision then stays PENDING and can never become approval-eligible (fail closed). Tests inject synthetic ones.
 */
let marketDataProvider: MarketDataProvider | undefined;
export function configureMarketDataProvider(provider: MarketDataProvider | undefined): void {
  marketDataProvider = provider;
}
let marketAlerter: Alerter | null | undefined;
function alertMarket(log: StructuredLogger, a: MarketAlert): void {
  if (marketAlerter === undefined) {
    try { marketAlerter = alerterFromEnv(process.env, "worker", log); } catch { marketAlerter = null; }
  }
  marketAlerter?.alert({ ...a, dedupeKey: `${a.code}:${a.details.reason}:${a.details.kind}` });
}

// Stage 5: the agent engine. DISABLED by default (TWINS_AGENT_ENGINE_ENABLED): then the registry is empty, nothing is loaded and the risk flow below is exactly as before. Only when it is
// explicitly enabled are the production agents (signal integrity, instrument verification) registered - with the configured rules and instrument reference. A malformed configuration
// or an unreadable instrument-reference file throws here, at start-up (fail closed).
// Stage 5 / Task 9: a malformed configuration is logged (redacted: setting names, never values) before start-up fails; the engine's records are bounded (see observability.ts).
const observabilityConfig = observeConfigLoad(defaultWorkerLogger, "agent-observability", () => loadObservabilityConfig());
const agentEngineConfig = observeConfigLoad(defaultWorkerLogger, "agent-engine", () => loadAgentEngineConfig());
const agentRules = agentEngineConfig.enabled || agentEngineConfig.shadow ? observeConfigLoad(defaultWorkerLogger, "agent-rules", () => loadAgentRulesConfig()) : null;
const agentRegistries = new WeakMap<Db, ReturnType<typeof createDefaultRegistry>>();
const agentReference = agentRules ? observeConfigLoad(defaultWorkerLogger, "agent-instrument-reference", () => resolveInstrumentReference(agentRules.instrument.referenceSource)) : null;
const agentProviders = agentRules ? observeConfigLoad(defaultWorkerLogger, "agent-providers", () => ({ ...resolveCalendarMacroProviders(agentRules), ...resolveNewsConstituentProviders(agentRules), ...resolveOhlcProviders(agentRules), ...resolveQuoteProviders(agentRules), ...resolveHistoricalProviders(agentRules) })) : null;
if (agentRules) logProviderAvailability(defaultWorkerLogger, observabilityConfig, { ...(agentProviders ?? {}), instrumentReference: agentReference }, true);
const agentRegistryFor = (db: Db): ReturnType<typeof createDefaultRegistry> => {
  if (!agentRules) return createDefaultRegistry();
  let r = agentRegistries.get(db);
  if (!r) { r = createProductionRegistry({ rules: agentRules, instrumentReference: agentReference, historicalReference: historicalDatasetReference(db), ...(agentProviders ?? {}) }); agentRegistries.set(db, r); }
  return r;
};
const agentEngineFor = (log: StructuredLogger, db: Db) => async (decisionId: string) => {
  const observer = createRunObserver(log, observabilityConfig, { riskDecisionId: decisionId });
  try {
    const result = await runAgentEngine(db, decisionId, { registry: agentRegistryFor(db), config: agentEngineConfig, emit: observer.emit });
    observer.completed(result);
    return result;
  } catch (error) {
    observer.failed(error);
    throw error;
  }
};

/** Shadow mode (HB-06): evaluate and LOG only. Never throws, never halts, writes nothing; the caller ignores the outcome except for the log line. */
const agentShadowFor = (log: StructuredLogger, db: Db) => async (decisionId: string): Promise<void> => {
  const r = await runAgentEngineShadow(db, decisionId, { registry: agentRegistryFor(db), config: agentEngineConfig });
  if (r.skipped === "SHADOW_OFF" || r.skipped === "ENGINE_ENFORCING") return;
  if (r.skipped !== undefined) { log.warn("agent_engine.shadow.failed", { riskDecisionId: decisionId, reason: r.skipped, errorCode: "errorCode" in r ? r.errorCode : "ERROR" }); return; }
  const count = (k: string) => r.agents.filter((a) => a.status === k).length;
  const fields = { riskDecisionId: r.riskDecisionId, status: r.status, assessment: r.assessment, wouldHalt: r.wouldHalt, durationMs: r.durationMs, agents: r.agents.length, completed: count("COMPLETED"), failed: count("FAILED"), timedOut: count("TIMEOUT"), skippedAgents: count("SKIPPED"), unavailable: count("UNAVAILABLE"), perAgent: r.agents.map((a) => `${a.agentId}:${a.status}:${a.verdict}`).join(",").slice(0, 900) };
  if (r.wouldHalt) log.warn("agent_engine.shadow.assessed", fields); else log.info("agent_engine.shadow.assessed", fields);
};

async function recordPendingRiskDecision(
  log: StructuredLogger,
  create: () => ReturnType<typeof createPendingRiskDecisionForSignal>,
  subject: { signalId?: string; optionsClaimId?: string },
  size?: () => ReturnType<typeof sizeLatestRiskDecisionForSignal>,
  evaluate?: (decisionId: string) => ReturnType<typeof evaluatePortfolioRisk>,
  db?: Db,
  intel?: () => ReturnType<typeof recordIntelligenceForSignal>,
  agents?: (decisionId: string) => ReturnType<typeof runAgentEngine>,
  shadow?: (decisionId: string) => Promise<void>,
): Promise<void> {
  try {
    const r = await create();
    if (r.skipped) {
      log.warn("worker.risk_decision.skipped", { reason: r.skipped, ...subject });
      return;
    }
    log.info("worker.risk_decision.recorded", { riskDecisionId: r.id, created: r.created, status: r.status, decisionVersion: r.decisionVersion, ...subject });
    // Stage 4 / Task 5: record point-in-time source intelligence (trust tier + calibrated confidence) as a new decision version BEFORE sizing. Unavailable intelligence is recorded as such
    // (the decision stays PENDING with an explicit reason and cannot be sized or approved); a database / runtime-state error propagates, so the job fails closed and is retried.
    let latestId = r.id;
    if (intel) {
      const ir = await intel();
      if ("skipped" in ir) log.info("worker.source_intelligence.skipped", { reason: ir.skipped, ...subject });
      else { latestId = ir.id; log.info("worker.source_intelligence.recorded", { riskDecisionId: ir.id, created: ir.created, intelligenceStatus: ir.intelligenceStatus, reasonCode: ir.reasonCode, trustTier: ir.trustTier, confidenceTier: ir.confidenceTier, decisionVersion: ir.decisionVersion, ...subject }); }
    }
    // Stage 5 / Task 1: the agent-engine extension point (after source intelligence, before sizing and the later gates). Disabled by default => skipped, nothing changes. When enabled, a
    // BLOCKED / INCOMPLETE / ADVERSE research assessment (or a missing required agent result) stops the flow here: the decision stays PENDING and can never be sized, gated or approved.
    // The assessment never grants approval and never bypasses a later gate. A database or runtime-state error propagates (fail closed).
    if (agents) {
      const ar = await agents(latestId);
      if (!ar.skipped) {
        log.info("worker.agent_engine.recorded", { riskDecisionId: ar.riskDecisionId, runId: ar.runId, created: ar.created, status: ar.status, assessment: ar.assessment, agents: ar.agents, ...subject });
        if (ar.halt) { log.warn("worker.agent_engine.halted", { riskDecisionId: ar.riskDecisionId, assessment: ar.assessment, ...subject }); return; }
      }
    }
    // Shadow mode (HB-06): observe-only. Runs after the enforcing hook, can never halt or fail the flow (errors are swallowed and logged), writes nothing.
    if (shadow) { try { await shadow(latestId); } catch { log.warn("agent_engine.shadow.failed", { riskDecisionId: latestId, reason: "SHADOW_ERROR", errorCode: "ERROR" }); } }
    // Stage 3 / Task 2: append the position-size version. Planning only: no order, broker call or approval is produced.
    const sz = size ? await size() : undefined;
    if (!sz) return;
    if ("skipped" in sz && sz.skipped) log.info("worker.risk_sizing.skipped", { reason: sz.skipped, ...subject });
    else if (!("skipped" in sz)) log.info("worker.risk_sizing.recorded", { riskDecisionId: sz.id, created: sz.created, sizingStatus: sz.sizingStatus, reasonCode: sz.reasonCode, quantity: sz.quantity, decisionVersion: sz.decisionVersion, ...subject });
    // Stage 3 / Task 3: a successfully sized (PENDING) decision is evaluated against the portfolio limits; the result is a new version. Review state only: no order, card or broker call.
    if (evaluate && !("skipped" in sz) && sz.sizingStatus === "SIZED" && sz.status === "PENDING") {
      const pf = await evaluate(sz.id);
      log.info("worker.risk_portfolio.recorded", { riskDecisionId: pf.id, created: pf.created, portfolioOutcome: pf.portfolioOutcome, reasonCode: pf.reasonCode, decisionVersion: pf.decisionVersion, ...subject });
      // Stage 3 / Task 5: a portfolio-passed decision is evaluated against the market-risk gates. Only a PASS becomes APPROVED_FOR_REVIEW (review state: no order, card or broker call).
      if (db && pf.portfolioOutcome === "APPROVED_FOR_REVIEW" && pf.status === "PENDING") {
        if (!marketDataProvider) log.info("worker.risk_market.skipped", { reason: "no_market_data_provider", riskDecisionId: pf.id, ...subject });
        else {
          try {
            const mk = await evaluateMarketRisk(db, pf.id, { provider: marketDataProvider, onMarketAlert: (a) => alertMarket(log, a) });
            log.info("worker.risk_market.recorded", { riskDecisionId: mk.id, created: mk.created, marketOutcome: mk.marketOutcome, reasonCode: mk.reasonCode, decisionVersion: mk.decisionVersion, ...subject });
          } catch (error) {
            // missing market data / event windows is not a job failure: the decision simply stays PENDING (never approved)
            if (error instanceof RiskDecisionError && (error.code === "market_data_unavailable" || error.code === "event_windows_unavailable")) log.warn("worker.risk_market.skipped", { reason: error.code, riskDecisionId: pf.id, ...subject });
            else throw error;
          }
        }
      }
    }
  } catch (error) {
    if (error instanceof RiskDecisionError && error.cause instanceof SafetyRefusalError) throw error.cause;
    throw error;
  }
}

// ─── Telegram pipeline ─────────────────────────────────────────────────────

/**
 * Full Telegram → validation pipeline for one message.
 *
 * Steps:
 *  1. Insert the telegram_messages row (idempotent via unique index).
 *  2. Extract a structured signal from rawText; skip if no BUY/SELL found.
 *  3. Refresh market context for the signal's instrument via Yahoo Finance.
 *  4. Run the full validation pipeline (Phases 5–9).
 *
 * Correlation ID is generated here so every log line for this job can be
 * traced end-to-end. No AI/LLM calls occur anywhere in this path.
 */
export async function processTelegramJob(
  job: Job<TelegramJobPayload>,
  correlationId?: string,
  db: Db = workerDb.db,
  options: TelegramJobOptions = {},
): Promise<TelegramJobOutcome> {
  // When called through processTelegramQueueJob the logger already carries the job context.
  const log = options.logger ?? defaultWorkerLogger.child(buildJobLogContext(job, correlationId));
  const policy = options.intakePolicy ?? defaultIntakePolicy;

  // Gate 1 - approved chat. Runs before ANY write or downstream work: no jobs row, source, message, signal, instrument,
  // market request or validation exists for a chat that is not approved. The job completes (it is not retried).
  const queuedMessage = job.data?.telegram?.normalizedMessage;
  const queuedChatId = queuedMessage ? chatIdOfQueuedMessage(queuedMessage) : null;
  if (!policy.isChatApproved(queuedChatId)) { // a null (unusable) id is never approved by a real policy
    log.warn("worker.intake.chat_rejected", { reason: queuedChatId === null ? "chat_id_unusable" : "chat_not_approved", chatId: queuedChatId });
    return { outcome: "chat_not_approved", reasonCodes: [queuedChatId === null ? "chat.id_unusable" : "chat.not_approved"] };
  }

  // Gate 2 - explicit options-only mode (fail closed). Only a message the options path will handle may proceed; an
  // equity-style directive, an equity-ambiguous message, a message with no directive or an unusable text is blocked here,
  // before ingestion, so it can never reach the equity signal / instrument / market-data pipeline. This is a parser
  // classification only: it verifies nothing about an options contract or premium.
  if (policy.optionsOnly) {
    const text = queuedMessage?.rawText;
    const analysis = typeof text === "string" ? analyzeTelegramText(text) : undefined;
    const optionsFlow = analysis !== undefined && (analysis.kind === "options_claim" || analysis.kind === "options_unsupported" || (analysis.kind === "ambiguous" && analysis.optionsRelated === true));
    if (!optionsFlow) {
      log.warn("worker.intake.non_options_blocked", { analysisKind: analysis?.kind ?? "unreadable" });
      return { outcome: "non_options_blocked", reasonCodes: ["options_only.not_an_options_message"] };
    }
  }

  const { telegram } = job.data;
  const { exchange, instrumentType } = telegram;
  // BullMQ serialises job data as JSON, so Date fields arrive as ISO strings.
  const normalizedMessage = {
    ...telegram.normalizedMessage,
    messageTimestamp: parseJobTimestamp(telegram.normalizedMessage.messageTimestamp),
    ...(telegram.normalizedMessage.editDate !== undefined && telegram.normalizedMessage.editDate !== null
      ? { editDate: parseJobTimestamp(telegram.normalizedMessage.editDate, "editDate") }
      : {}),
  };


  // User API captures carry their provenance (validated strictly); Bot API webhook jobs have none and stay on the original path.
  const capture = telegram.capture !== undefined ? parseCapture(telegram.capture) : undefined;
  const ingestProviderName = capture ? USER_CAPTURE_PROVIDER_NAME : TELEGRAM_BOT_WEBHOOK_PROVIDER_NAME;

  // Step 1 — Ingest the telegram message (idempotent).
  // We wrap the single already-normalized message in a synthetic provider so
  // runIngestionJob's bookkeeping still fires (jobs + provider_health rows).
  const summary = await runIngestionJob(db, {
    jobType: "telegram_messages",
    queueName: "signal_queue",
    providerName: ingestProviderName,
    providerType: "telegram",
    payload: job.data,
    execute: async () => {
      return ingestTelegramMessages(
        db,
        {
          providerName: ingestProviderName,
          async fetchMessages() {
            return [normalizedMessage];
          },
          async getHealth() {
            return {
              providerName: ingestProviderName,
              providerType: "telegram",
              status: "healthy",
              checkedAt: new Date(),
            };
          },
        },
        telegram.params,
        capture
          ? { captureMethod: capture.captureMethod, observedAt: capture.observedAt, ...(capture.importedAt ? { importedAt: capture.importedAt } : {}) }
          : undefined,
      );
    },
  });

  if (summary.status === "failed") {
    // Throw so BullMQ attempts/backoff apply; returning would report success and lose the message.
    // The underlying error text stays in the `jobs` table; it is not copied into logs or the queue.
    throw Object.assign(new Error("telegram ingestion failed"), { code: "INGESTION_FAILED" });
  }

  const ingestResult = summary.result;
  if (!ingestResult) return { outcome: "message_row_missing" };

  log.info("worker.message.ingested", {
    inserted: ingestResult.inserted,
    duplicates: ingestResult.duplicates,
    rejectedInvalid: ingestResult.rejectedInvalid,
  });
  if (ingestResult.rejectedInvalid > 0) {
    log.warn("worker.message.rejected", { reason: "data_quality" });
    return { outcome: "rejected_data_quality" };
  }

  // Step 2 — Extract signal from the just-ingested message.
  // We need the DB-assigned telegram_messages.id to pass to createSignalFromTelegramMessage.
  const { schema } = await import("@twins/database");
  const { and, eq, isNull } = await import("drizzle-orm");

  // Source-scoped lookup: external message ids are only unique per channel. The source is
  // resolved by chat.id when known (stable across renames), exactly as ingestion did.
  const sourceId = await resolveTelegramSource(db, {
    channelIdentifier: normalizedMessage.channelIdentifier,
    chatId: normalizedMessage.chatId,
    displayName: normalizedMessage.channelDisplayName,
  });
  const [telegramRow] = await db
    .select({ id: schema.telegramMessages.id, originMessageId: schema.telegramMessages.originMessageId, firstSeenEdited: schema.telegramMessages.firstSeenEdited })
    .from(schema.telegramMessages)
    .where(
      and(
        eq(schema.telegramMessages.telegramSourceId, sourceId),
        eq(schema.telegramMessages.externalMessageId, normalizedMessage.externalMessageId),
      ),
    );

  if (!telegramRow) {
    log.warn("worker.message.row_missing");
    return { outcome: "message_row_missing" };
  }

  // Observation record for User API captures: ONE append-only event per message ("seen") or per observed edit
  // ("edited_observed"); the text itself is never copied (SHA-256 only). Idempotent by key, so a redelivery adds nothing.
  if (capture) {
    await recordCaptureEvent(db, {
      telegramSourceId: sourceId,
      telegramMessageId: telegramRow.id,
      externalMessageId: normalizedMessage.originMessageId ?? normalizedMessage.externalMessageId,
      eventType: normalizedMessage.editDate !== undefined ? "edited_observed" : "seen",
      captureMethod: capture.captureMethod,
      observedAt: capture.observedAt,
      sourceEditDate: normalizedMessage.editDate ?? null,
      contentSha256: textSha256Hex(normalizedMessage.rawText),
      meta: {
        ...(capture.importBatchId ? { importBatchId: capture.importBatchId } : {}),
        ...(capture.clientObservedAt ? { clientObservedAt: capture.clientObservedAt } : {}),
        firstSeenEdited: telegramRow.firstSeenEdited,
      },
    });
  }

  // Informational: where this revision stands. Currentness is derived from edit_date,
  // never from arrival order; it is NOT approval invalidation (not implemented).
  const revisionStates = await getRevisionStates(
    db,
    sourceId,
    normalizedMessage.originMessageId ?? normalizedMessage.externalMessageId,
  );
  const ownState = revisionStates.find((r) => r.id === telegramRow.id);
  log.info("worker.revision.state", { state: ownState?.state ?? "unknown", reason: ownState?.reason ?? "n/a" });

  // Step 2 — Canonical signal for (message, parser version). The unique index is
  // the correctness boundary: concurrent or repeated callers all receive the same
  // signal id (created: false / reused: true for the losers). Re-running after a
  // partial failure therefore resumes instead of skipping or duplicating.
  const signalOutcome = await createSignalFromTelegramMessage(db, telegramRow.id, {
    exchange,
    instrumentType,
  });

  if (signalOutcome.reconciliationRequired) {
    throw new ReconciliationRequiredError(signalOutcome.reason ?? "reconciliation required");
  }
  if (policy.optionsOnly && signalOutcome.signalId) {
    // Defence in depth: gate 2 let an options message through, yet an equity signal exists for this message (e.g. created
    // by an older parser version). Options-only mode never continues into validation or market data for it.
    log.warn("worker.intake.non_options_blocked", { analysisKind: "existing_equity_signal" });
    return { outcome: "non_options_blocked", reasonCodes: ["options_only.equity_signal_present"] };
  }
  if (signalOutcome.optionsIntake) {
    // Options-style message: stored raw (telegram_messages) and recorded as an UNVERIFIED options claim row. Never an
    // equity signal, instrument, approval or order. Only a master that was explicitly configured is used (and recorded).
    const intake = signalOutcome.optionsIntake;
    const master = options.optionsMaster ?? configuredOptionsMaster;
    const assessment = intake.kind === "claim" ? await assessOptionsClaim(intake.claim, master ?? unconfiguredContractMaster, unavailablePremiumProvider, stopLossConfig) : undefined;
    const record = await recordOptionsIntake(db, {
      telegramMessageId: telegramRow.id,
      parserVersion: signalOutcome.parserVersion ?? TELEGRAM_PARSER_VERSION,
      intake,
      assessment,
      master,
      premium: null,
    });
    const reasonCodes = assessment
      ? assessment.reasons.map((x) => x.code)
      : [intake.kind === "ambiguous" ? "directives.ambiguous" : "underlying.unsupported_options_shape"];
    if (intake.kind === "claim") await recordPendingRiskDecision(log, () => createPendingRiskDecisionForOptionsClaim(db, record.id), { optionsClaimId: record.id }, () => sizeLatestRiskDecisionForOptionsClaim(db, record.id, { requireIntelligence: true }), (id) => evaluatePortfolioRisk(db, id), db, () => recordIntelligenceForOptionsClaim(db, record.id), agentEngineFor(log, db), agentShadowFor(log, db));
    log.warn("worker.options.claim_not_ingested", {
      resultKind: intake.kind,
      assessment: assessment?.outcome,
      ...(intake.kind === "claim"
        ? { underlying: intake.claim.underlying, optionType: intake.claim.optionType, strike: intake.claim.strike, action: intake.claim.action, expiryStatus: intake.claim.expiry.status, levelBasis: intake.claim.levelBasis }
        : {}),
      reasonCodes,
      optionsClaimId: record.id,
      recordCreated: record.created,
      differsFromStored: record.differsFromStored,
    });
    return { outcome: "options_claim_not_ingested", reasonCodes, optionsClaimId: record.id };
  }
  if (signalOutcome.unsupported) {
    const reasonCodes = signalOutcome.unsupportedCodes ?? ["unsupported"];
    log.warn("worker.signal.unsupported", { reasonCodes });
    return { outcome: "options_claim_not_ingested", reasonCodes };
  }
  if (!signalOutcome.signalId) {
    log.info("worker.signal.none", { reason: signalOutcome.ambiguous ? "ambiguous_message" : "no_directive" });
    return { outcome: signalOutcome.ambiguous ? "ambiguous_message_no_signal" : "no_signal" };
  }
  const signalId = signalOutcome.signalId;
  log.info("worker.signal.resolved", { signalId, signalCreated: signalOutcome.created, parserVersion: signalOutcome.parserVersion });

  // Validation provenance. Only a row carrying one of this signal's ingestion keys is
  // DEMONSTRABLY an ingestion validation, so only such a row lets us stand down. Keyless
  // validations (legacy or manual) have unknown provenance: they are preserved untouched
  // and are not proof. In that case ONE newly computed snapshot is appended under the
  // distinct key `telegram-ingest-recompute:<signalId>` so it is identifiable as a
  // recomputation made at retry time (its validated_at is the computation time) and is
  // never mistaken for evidence available at the original signal time. Further retries
  // find the key and create nothing.
  const primaryKey = `telegram-ingest:${signalId}`;
  const recomputeKey = `telegram-ingest-recompute:${signalId}`;
  if ((await findValidationByKey(db, primaryKey)) || (await findValidationByKey(db, recomputeKey))) {
    log.info("worker.validation.skipped_existing", { signalId });
    await recordPendingRiskDecision(log, () => createPendingRiskDecisionForSignal(db, signalId), { signalId }, () => sizeLatestRiskDecisionForSignal(db, signalId, { requireIntelligence: true }), (id) => evaluatePortfolioRisk(db, id), db, () => recordIntelligenceForSignal(db, signalId), agentEngineFor(log, db), agentShadowFor(log, db)); // resume: a crash after validation must not leave the signal without its risk decision
    return { outcome: "validation_already_existed", signalId };
  }
  const [unknownProvenance] = await db
    .select({ id: schema.signalValidations.id })
    .from(schema.signalValidations)
    .where(and(eq(schema.signalValidations.signalId, signalId), isNull(schema.signalValidations.idempotencyKey)));
  const validationKey = unknownProvenance ? recomputeKey : primaryKey;
  if (unknownProvenance) {
    log.warn("worker.validation.unknown_provenance", { signalId, resumePolicy: "append_one_recompute_snapshot" });
  }

  // Step 3 — Refresh market context for the signal's instrument.
  // Fetch the last 30 days of daily bars so the Phase 6 context window has
  // data to work with. Failures here are non-blocking: the validation pipeline
  // will proceed with whatever context is already in the DB (it handles missing
  // data gracefully per spec section 2).
  try {
    const [signal] = await db
      .select({ instrumentId: schema.signals.instrumentId })
      .from(schema.signals)
      .where(eq(schema.signals.id, signalId));

    if (signal) {
      const [instrument] = await db
        .select({ symbol: schema.instruments.symbol, exchange: schema.instruments.exchange })
        .from(schema.instruments)
        .where(eq(schema.instruments.id, signal.instrumentId));

      if (instrument) {
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const marketRequest: MarketBarRequest = {
          instrument: { symbol: instrument.symbol, exchange: instrument.exchange },
          timeframe: "1d",
          from: thirtyDaysAgo,
          to: now,
        };

        await runIngestionJob(db, {
          jobType: "market_bars",
          queueName: "market_queue",
          providerName: YAHOO_PROVIDER_NAME,
          providerType: "market",
          payload: { instrument: instrument.symbol, timeframe: "1d" },
          execute: () =>
            ingestMarketBars(db, marketDataProviders.get(YAHOO_PROVIDER_NAME), marketRequest, {
              instrumentType,
              maxStalenessMs: 24 * 60 * 60 * 1000,
            }),
        });

        log.info("worker.market_context.refreshed", { symbol: instrument.symbol });
      }
    }
  } catch (err) {
    log.warn("worker.market_context.refresh_failed", { blocking: false, ...describeErrorSafely(err) });
  }

  // Step 4 — Run the deterministic validation pipeline (Phases 5–9).
  // validateSignal() calls assembleSignalIntelligence() internally and
  // persists an immutable signal_validations row.
  const validation = await validateSignal(db, signalId, {
    idempotencyKey: validationKey,
    // Explicit analysis inputs: the Yahoo daily bars this worker just refreshed (never synthetic rows), cut at now.
    // No macro relevance rule exists yet, so no macro row is used as evidence.
    asOf: new Date(),
    intelligence: { market: options.analysisMarket ?? { source: YAHOO_PROVIDER_NAME, timeframe: "1d" } },
  });

  log.info("worker.validation.recorded", {
    signalId,
    validationId: validation.validationId,
    validationReused: validation.reused,
    decision: validation.result?.outcome,
  });
  await recordPendingRiskDecision(log, () => createPendingRiskDecisionForSignal(db, signalId), { signalId }, () => sizeLatestRiskDecisionForSignal(db, signalId, { requireIntelligence: true }), (id) => evaluatePortfolioRisk(db, id), db, () => recordIntelligenceForSignal(db, signalId), agentEngineFor(log, db), agentShadowFor(log, db));
  return {
    outcome: validation.reused ? "validation_already_existed" : "validation_created",
    signalId,
    validationId: validation.validationId,
  };
}

// ─── Market bars pipeline (scheduler-driven) ───────────────────────────────

export async function processMarketBarsJob(
  job: Job<MarketBarsJobPayload>,
  correlationId: string,
  db: Db = workerDb.db,
): Promise<void> {
  const { market } = job.data;

  const request: MarketBarRequest = {
    instrument: market.request.instrument,
    timeframe: market.request.timeframe,
    from: new Date(market.request.from),
    to: new Date(market.request.to),
  };

  console.log(
    `[worker][${correlationId}] market_bars job symbol=${market.request.instrument.symbol} timeframe=${market.request.timeframe}`,
  );

  const outcome = await runIngestionJob(db, {
    jobType: "market_bars",
    queueName: "market_queue",
    providerName: job.data.providerName,
    providerType: "market",
    payload: job.data,
    execute: () =>
      ingestMarketBars(db, marketDataProviders.get(job.data.providerName), request, {
        instrumentType: market.instrumentType,
        maxStalenessMs: market.maxStalenessMs,
      }),
  });

  console.log(
    `[worker][${correlationId}] market_bars result status=${outcome.status} inserted=${outcome.result?.inserted ?? 0}`,
  );
}

// ─── BullMQ workers ────────────────────────────────────────────────────────

// BullMQ Workers require maxRetriesPerRequest: null. Each worker gets its own
// explicit ioredis client (native ESM cannot lazy-load ioredis from options).
const workerRedisClients: Redis[] = [];
const createWorkerRedis = (): Redis => {
  const client = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  workerRedisClients.push(client);
  return client;
};

// Restart-loop detection: the third start inside 10 minutes raises a CRITICAL alert (best effort; needs Redis).
if (process.env["NODE_ENV"] !== "test") {
  const startRedis = createWorkerRedis();
  void recordProcessStart(
    { incr: async (key, ttl) => { const n = await startRedis.incr(key); if (n === 1) await startRedis.expire(key, ttl); return n; } },
    "worker",
    defaultWorkerLogger,
  ).finally(() => void startRedis.quit().catch(() => undefined));
}

// In test environment, do not start active BullMQ worker event loops unless explicitly triggered
export const signalWorker: Worker<SignalQueueJobPayload> =
  process.env["NODE_ENV"] === "test"
    ? (null as unknown as Worker<SignalQueueJobPayload>)
    : new Worker<SignalQueueJobPayload>(
        "signal_queue",
        // Intake gate (Stage 1 / Task 2): while intake is disabled, the kill switch is active or the state is unreadable the job goes back to
        // the queue untouched (no attempt consumed, nothing lost) and the worker pauses; see ./safetyGate.ts.
        withIntakeGate((job: Job<SignalQueueJobPayload>) => processSignalQueueJob(job), () => signalWorker, { logger: defaultWorkerLogger }),
        {
          connection: createWorkerRedis(),
          concurrency: 2,
        },
      );

export const marketWorker =
  process.env["NODE_ENV"] === "test"
    ? (null as unknown as Worker<MarketBarsJobPayload>)
    : new Worker<MarketBarsJobPayload>(
        "market_queue",
        async (job: Job<MarketBarsJobPayload>) => {
          const correlationId = randomUUID().slice(0, 8);
          await processMarketBarsJob(job, correlationId);
        },
        {
          connection: createWorkerRedis(),
          concurrency: 4,
        },
      );

// Outbox reconciler (Stage 2 / Task 2): re-enqueues outbox rows whose Redis job was never created or was lost, and recovers rows orphaned by a dead worker.
// It does nothing while intake is disabled or the kill switch is active. Interval / lease are configurable; defaults 10 s / 5 min.
const positiveMs = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000 || n > 86_400_000) throw new Error(`${name} must be an integer number of milliseconds between 1000 and 86400000`);
  return n;
};
const outboxQueue = process.env["NODE_ENV"] === "test" ? null : new Queue("signal_queue", { connection: createWorkerRedis() });
const outboxReconciler = outboxQueue
  ? startOutboxReconciler(workerDb.db, {
      logger: defaultWorkerLogger,
      queue: outboxQueue,
      intervalMs: positiveMs("TWINS_OUTBOX_RECONCILE_INTERVAL_MS", 10_000),
      leaseMs: positiveMs("TWINS_OUTBOX_LEASE_MS", 300_000),
    })
  : null;

if (signalWorker) {
  // Per-attempt detail is logged by processTelegramQueueJob; this reports the queue-level result
  // without the error message (which may embed row values).
  signalWorker.on("failed", (job, err) => {
    defaultWorkerLogger.warn("worker.queue.job_failed", {
      queue: "signal_queue",
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      maxAttempts: job?.opts?.attempts,
      ...describeErrorSafely(err),
    });
  });
}

if (marketWorker) {
  marketWorker.on("completed", (job) => {
    console.log(`[worker] market_queue job ${job.id} completed`);
  });
  marketWorker.on("failed", (job, err) => {
    console.error(`[worker] market_queue job ${job?.id} failed: ${err.message}`);
  });
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

export async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] received ${signal}, shutting down gracefully`);
  outboxReconciler?.stop();
  const closers: Array<Promise<unknown>> = [];
  if (outboxQueue) closers.push(outboxQueue.close());
  if (signalWorker) closers.push(signalWorker.close());
  if (marketWorker) closers.push(marketWorker.close());
  for (const r of await Promise.allSettled(closers)) {
    if (r.status === "rejected") console.error(`[worker] close failed: ${String(r.reason)}`);
  }
  await Promise.allSettled(workerRedisClients.map((c) => c.quit().catch(() => c.disconnect())));
  await workerDb.close();
  process.exit(0);
}

process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT",  () => { void shutdown("SIGINT"); });

if (process.env["NODE_ENV"] !== "test") {
  console.log("[worker] listening on signal_queue and market_queue");
}

// Keep the process alive (the BullMQ workers run their event loops internally).
export { dispatchIngestionJob } from "./ingestionDispatch.js";
