import { and, eq } from "drizzle-orm";
import { schema } from "@twins/database";
import { resolveInstrument } from "@twins/ingestion";
import type { Db } from "./db";
import { analyzeTelegramText, analyzeTelegramTextV1, TELEGRAM_PARSER_VERSION, TELEGRAM_PARSER_VERSION_V1, type TelegramTextAnalysis } from "./extract";
import type { OptionsIntake } from "./options/persist";
import { isReservedUnderlyingToken, type OptionsClaim } from "./options/types";

export interface CreateSignalOptions {
  /** Telegram messages don't carry an exchange - the caller (a per-channel
   * config, not the message text) supplies which exchange its symbols
   * belong to. Never guessed from the message. */
  exchange: string;
  instrumentType: string;
}

export interface ReparseOptions extends CreateSignalOptions {
  /** REQUIRED: an explicit reparse always names the parser version it runs. */
  parserVersion: string;
  /** Parser implementations by version. Defaults to the parsers shipped in this package. */
  parsers?: Record<string, (rawText: string) => TelegramTextAnalysis>;
}

export const SHIPPED_TELEGRAM_PARSERS: Record<string, (rawText: string) => TelegramTextAnalysis> = {
  [TELEGRAM_PARSER_VERSION_V1]: analyzeTelegramTextV1,
  [TELEGRAM_PARSER_VERSION]: analyzeTelegramText,
};

export interface CreateSignalOutcome {
  /** True only for the caller whose INSERT created the row. */
  created: boolean;
  /** True when an existing canonical signal was reused (nothing inserted). */
  reused?: boolean;
  signalId?: string;
  reason?: string;
  /** True when the message held several distinct directives and was deliberately not turned into a signal. */
  ambiguous?: boolean;
  /** True when existing signals have no unambiguous canonical record; a human must reconcile. */
  reconciliationRequired?: boolean;
  /** Parser version of the signal that was reused/created. */
  parserVersion?: string;
  /** True when the message was recognized as an unsupported/unverified options claim; no signal and no instrument were created. */
  unsupported?: boolean;
  /** The parsed (unverified) options claim, when unsupported is set by the options path. */
  optionsClaim?: OptionsClaim;
  /** The options-style intake (claim / ambiguous / unsupported) to be recorded by the caller. Never a signal. */
  optionsIntake?: OptionsIntake;
  /** Stable codes for an unsupported intake without a parsed claim (e.g. an unsupported underlying). */
  unsupportedCodes?: string[];
}

type MessageRow = typeof schema.telegramMessages.$inferSelect;

async function loadMessage(db: Db, telegramMessageId: string): Promise<MessageRow> {
  const [message] = await db
    .select()
    .from(schema.telegramMessages)
    .where(eq(schema.telegramMessages.id, telegramMessageId));
  if (!message) throw new Error(`telegram_messages row not found: ${telegramMessageId}`);
  return message;
}

function describeNoSignal(analysis: TelegramTextAnalysis): CreateSignalOutcome {
  if (analysis.kind === "options_unsupported") {
    return {
      created: false,
      unsupported: true,
      unsupportedCodes: ["underlying.unsupported_options_shape"],
      optionsIntake: { kind: "unsupported", symbol: analysis.symbol, form: analysis.form },
      reason: `options-shaped directive (${analysis.form}) with an unsupported underlying "${analysis.symbol}"; not mapped or corrected, no instrument created`,
    };
  }
  if (analysis.kind === "options_claim") {
    return {
      created: false,
      unsupported: true,
      optionsClaim: analysis.claim,
      optionsIntake: { kind: "claim", claim: analysis.claim },
      reason: "options claim: contract unverifiable and options signals are not ingested as signals in this phase",
    };
  }
  if (analysis.kind === "ambiguous") {
    return {
      created: false,
      ambiguous: true,
      ...(analysis.optionsRelated ? { optionsIntake: { kind: "ambiguous" as const, directives: analysis.directives } } : {}),
      reason: `ambiguous: ${analysis.directives.length} distinct BUY/SELL directives; multi-signal messages are unsupported by this parser version`,
    };
  }
  return { created: false, reason: "no recognizable BUY/SELL directive in message text" };
}

/**
 * Conflict-safe insert of the canonical signal for (message, parserVersion).
 * The unique index is the correctness boundary: a concurrent loser inserts nothing
 * and reuses the winner's row.
 */
async function insertCanonicalSignal(
  db: Db,
  message: MessageRow,
  analysis: Extract<TelegramTextAnalysis, { kind: "signal" }>,
  parserVersion: string,
  options: CreateSignalOptions,
): Promise<CreateSignalOutcome> {
  const parsed = analysis.signal;
  // Defence in depth for every parser version (including an explicit v1 reparse): an index underlying is never
  // resolved/created as a plain equity instrument.
  if (isReservedUnderlyingToken(parsed.symbol)) {
    return { created: false, unsupported: true, unsupportedCodes: ["underlying.index_not_equity"], reason: "index underlying symbol is not an equity; options claims are handled by the options path" };
  }
  const instrumentId = await resolveInstrument(
    db,
    { symbol: parsed.symbol, exchange: options.exchange },
    options.instrumentType,
  );

  const [row] = await db
    .insert(schema.signals)
    .values({
      sourceType: "telegram",
      telegramMessageId: message.id,
      parserVersion,
      instrumentId,
      direction: parsed.direction,
      entryPrice: parsed.entryPrice?.toString(),
      stopLoss: parsed.stopLoss?.toString(),
      targets: parsed.targets,
      timeframe: parsed.timeframe,
      extractedConfidence: parsed.extractedConfidence?.toString(),
      status: "pending",
      // Availability time for no-look-ahead: a revision's content became known at
      // its edit_date; an original's at its message date. (Legacy `_edit` rows have
      // no edit_date and fall back to the original date.)
      signalTimestamp: message.editDate ?? message.messageTimestamp,
    })
    .onConflictDoNothing({
      target: [schema.signals.telegramMessageId, schema.signals.parserVersion],
    })
    .returning({ id: schema.signals.id });
  if (row) return { created: true, signalId: row.id, parserVersion };

  const [existing] = await db
    .select({ id: schema.signals.id })
    .from(schema.signals)
    .where(
      and(
        eq(schema.signals.telegramMessageId, message.id),
        eq(schema.signals.parserVersion, parserVersion),
      ),
    );
  if (!existing) throw new Error("signals insert conflicted but canonical row not found");
  return { created: false, reused: true, signalId: existing.id, parserVersion };
}

/**
 * RESUME / RETRY of ingestion for a stored message (spec section 18/19/61 - the
 * signal is an input, not a decision). It never re-parses under a different
 * parser version just because versions differ.
 *
 * Canonical record for a message, in order:
 *   1. the signal under the CURRENT parser version, if it exists;
 *   2. otherwise the single existing signal (e.g. a `legacy-unversioned` one);
 *   3. otherwise, with several existing signals and none under the current version,
 *      there is no unambiguous canonical record -> `reconciliationRequired`, nothing
 *      is created, chosen or deleted.
 * Only when NO signal exists is a new one created under the current parser version.
 * To run a different parser deliberately, use `reparseTelegramMessage`.
 */
export async function createSignalFromTelegramMessage(
  db: Db,
  telegramMessageId: string,
  options: CreateSignalOptions,
): Promise<CreateSignalOutcome> {
  const message = await loadMessage(db, telegramMessageId);

  const existing = await db
    .select({ id: schema.signals.id, parserVersion: schema.signals.parserVersion })
    .from(schema.signals)
    .where(eq(schema.signals.telegramMessageId, telegramMessageId));

  const current = existing.find((s) => s.parserVersion === TELEGRAM_PARSER_VERSION);
  const canonical = current ?? (existing.length === 1 ? existing[0] : undefined);
  if (canonical) {
    return { created: false, reused: true, signalId: canonical.id, parserVersion: canonical.parserVersion };
  }
  if (existing.length > 1) {
    return {
      created: false,
      reconciliationRequired: true,
      reason: `reconciliation required: ${existing.length} existing signals (${existing
        .map((s) => s.parserVersion)
        .join(", ")}) and none under the current parser version; no canonical record chosen`,
    };
  }

  const analysis = analyzeTelegramText(message.rawText);
  if (analysis.kind !== "signal") return { ...describeNoSignal(analysis), parserVersion: TELEGRAM_PARSER_VERSION };
  return insertCanonicalSignal(db, message, analysis, TELEGRAM_PARSER_VERSION, options);
}

/**
 * EXPLICIT reparse of a stored message under a named parser version. Creates (or,
 * idempotently, reuses) the signal for exactly that (message, version); other
 * versions' signals are left untouched. The version must be implemented, so a
 * label can never be attached to output produced by a different algorithm.
 */
export async function reparseTelegramMessage(
  db: Db,
  telegramMessageId: string,
  options: ReparseOptions,
): Promise<CreateSignalOutcome> {
  const parsers = options.parsers ?? SHIPPED_TELEGRAM_PARSERS;
  const parser = parsers[options.parserVersion];
  if (!parser) throw new Error(`unknown parser version: ${options.parserVersion}`);
  const message = await loadMessage(db, telegramMessageId);
  const analysis = parser(message.rawText);
  if (analysis.kind !== "signal") return describeNoSignal(analysis);
  return insertCanonicalSignal(db, message, analysis, options.parserVersion, options);
}
