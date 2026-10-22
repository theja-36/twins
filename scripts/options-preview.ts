/**
 * OFFLINE options-signal preview. Pure: it only runs the existing options parser and assessor on text you give it.
 * No database, Redis, worker/API, network or secrets are involved, and nothing is stored or sent. For a fully stated
 * contract it looks the contract up in the LOCAL MANUAL VERIFIED REFERENCE (data/options-reference/manual-reference.v1.json),
 * which starts empty and holds only entries the owner adds by hand. The invented SYNTHETIC SAMPLE reference and sample
 * premium quotes are available only with --sample-reference. A local reference is not live entitlement and does not
 * prove a contract is currently tradable. Flags: --reference <manual file>, --sample-reference, --premium <file>.
 *
 *   npm run options:preview -- "BUY NIFTY 24500 CE 29 OCT 2026 ABOVE 120 SL 90 TGT 150 180 PREMIUM"
 *   echo "BUY NIFTY ..." | npm run options:preview
 *
 * Exit codes: 0 = preview completed (whatever the assessment says: unverified, rejected, unsupported, ambiguous),
 *             2 = usage error (no input), 1 = the tool itself failed.
 * The examples in docs/tests are parser inputs only, not claims that any contract exists.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeTelegramText, TELEGRAM_PARSER_VERSION } from "../packages/signals/src/extract";
import { assessOptionsClaim } from "../packages/signals/src/options/assess";
import type { ContractVerification, OptionsContractMaster } from "../packages/signals/src/options/master";
import { unavailablePremiumProvider, type OptionsPremiumProvider, type PremiumLookup } from "../packages/signals/src/options/premium";
import { createProviderSnapshotContractMaster, parseProviderSnapshotFile, PROVIDER_LISTED_STATEMENT } from "../packages/signals/src/options/providerSnapshot";
import { createManualReferenceContractMaster, createReferenceContractMaster, parseManualReferenceFile, parseReferenceFile } from "../packages/signals/src/options/referenceMaster";
import { createSamplePremiumProvider, parsePremiumFile } from "../packages/signals/src/options/samplePremium";
import type { EntryCondition, ExpiryClaim, OptionsClaim } from "../packages/signals/src/options/types";

const dataPath = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), "../data/options-reference", name);
export const DEFAULT_MANUAL_REFERENCE_PATH = dataPath("manual-reference.v1.json");
export const DEFAULT_SAMPLE_REFERENCE_PATH = dataPath("sample-reference.v1.json");

/** The default master: the manual verified reference. Missing or malformed is a tool failure, never a silent fallback. */
export function loadManualReferenceMaster(path: string = DEFAULT_MANUAL_REFERENCE_PATH): OptionsContractMaster {
  return createManualReferenceContractMaster(parseManualReferenceFile(JSON.parse(readFileSync(path, "utf8"))));
}

/** The invented SYNTHETIC sample reference. Only used when explicitly requested. */
export function loadSampleReferenceMaster(path: string = DEFAULT_SAMPLE_REFERENCE_PATH): OptionsContractMaster {
  return createReferenceContractMaster(parseReferenceFile(JSON.parse(readFileSync(path, "utf8"))));
}

/** An imported provider snapshot. Only used when explicitly requested with --provider-snapshot. */
export function loadProviderSnapshotMaster(path: string): OptionsContractMaster {
  return createProviderSnapshotContractMaster(parseProviderSnapshotFile(JSON.parse(readFileSync(path, "utf8"))));
}

export const DEFAULT_PREMIUM_PATH = dataPath("sample-premium.v1.json");

/** Loads and strictly validates the SYNTHETIC sample premium file (used only on request). */
export function loadPremiumProvider(path: string = DEFAULT_PREMIUM_PATH): OptionsPremiumProvider {
  return createSamplePremiumProvider(parsePremiumFile(JSON.parse(readFileSync(path, "utf8"))));
}

const line = (label: string, value: string) => `  ${label.padEnd(26)}${value}`;

function describeExpiry(e: ExpiryClaim): string[] {
  switch (e.status) {
    case "missing": return ["status: missing - none stated, none inferred"];
    case "period_word": return [`status: period word "${e.word}" - does not identify a date, none resolved`];
    case "day_month": return [`day ${e.day}, month ${e.month}`, "status: year NOT stated - year not inferred, unresolved"];
    case "year_dependent": return [`day ${e.day}, month ${e.month}`, "status: 29 February without a year - depends on the year, unresolved"];
    case "year_two_digit": return [`day ${e.day}, month ${e.month}, year written as "${e.twoDigitYear}"`, "status: two-digit year left UNRESOLVED - no century policy, none inferred"];
    case "full": return [`${e.year}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")} (as written)`, "status: calendar-valid as written - NOT proof that an exchange contract exists"];
    case "invalid": return [`as written: ${e.raw}`, `status: INVALID - ${e.reason}`];
  }
}

function describeEntry(e: EntryCondition): string {
  switch (e.type) {
    case "range": return `range ${e.low} to ${e.high} (a condition, not a fill)`;
    case "market": return "market/CMP, no price stated";
    case "unspecified": return "not stated";
    default: return `${e.type} ${e.price} (${e.type === "at" ? "quoted entry" : "a trigger condition"}, not a fill)`;
  }
}

function describeClaim(c: OptionsClaim): string[] {
  const out = [
    line("Underlying:", c.underlyingAliasUsed ? `${c.underlying} (alias "BANK NIFTY" normalized)` : c.underlying),
    line("Action:", c.action ?? "not stated"),
    line("Intent:", c.intent === "long_entry_presumed" ? "long entry presumed from BUY (a presumption of the text)" : "UNRESOLVED (entry vs exit vs fresh short is not known; fresh short entry unsupported)"),
    line("Strike:", c.strike === null ? (c.compactCodeUnrecognized ? "not decoded (compact code unrecognized)" : "not stated") : String(c.strike)),
    line("Option type:", c.optionType ?? (c.optionTypeConflict ? "conflict (both CE and PE stated)" : "not stated")),
  ];
  const [first, ...rest] = describeExpiry(c.expiry);
  out.push(line("Expiry:", first ?? ""), ...rest.map((r) => line("", r)));
  out.push(
    line("Entry condition:", describeEntry(c.entry)),
    line("Level basis:", c.levelBasis === "unspecified" ? (c.levelBasisConflict ? "UNSPECIFIED (conflicting markers)" : "UNSPECIFIED (values kept, not interpreted)") : c.levelBasis),
    line("Stop-loss:", c.stopLoss === null ? "not stated" : String(c.stopLoss)),
    line("Targets (in order):", c.targets.length ? c.targets.join(", ") : "none stated"),
    line("Implied underlying view:", `${c.impliedUnderlyingView} (informational; separate from action and level basis)`),
  );
  return out;
}

function referenceTypeLabel(master: OptionsContractMaster): string {
  if (!master.reference) return "UNCONFIGURED (no instrument master is configured)";
  if (master.reference.kind === "provider_snapshot") return "PROVIDER SNAPSHOT (imported Dhan instrument file, provider-listed only; not exchange-independently verified)";
  return master.reference.kind === "manual_verified"
    ? "MANUAL VERIFIED REFERENCE (maintained by hand; not automatically refreshed)"
    : "SYNTHETIC SAMPLE (invented data; proves nothing about any real contract)";
}

function describeVerification(v: ContractVerification, master: OptionsContractMaster): string[] {
  const out: string[] = [line("Reference type:", referenceTypeLabel(master))];
  switch (v.status) {
    case "unconfigured": out.push(line("Contract verification:", "UNCONFIGURED (no instrument master is configured)")); break;
    case "reference_empty": out.push(line("Contract verification:", "MANUAL_REFERENCE_EMPTY (the manual verified reference has no entries yet; nothing was looked up and nothing fell back to the synthetic sample)")); break;
    case "not_attempted": out.push(line("Contract verification:", `NOT_ATTEMPTED (${v.reason})`)); break;
    case "not_found": out.push(line("Contract verification:", "NOT_FOUND (no exact match on underlying, strike, CE/PE and expiry; no nearest-expiry or fuzzy matching)")); break;
    case "ambiguous": out.push(line("Contract verification:", `AMBIGUOUS (${v.candidates} identical entries match exactly; none was chosen)`)); break;
    case "verified": {
      const c = v.contract;
      out.push(line("Contract verification:", `FOUND (exact match in the ${master.reference?.kind === "manual_verified" ? "manual verified" : master.reference?.kind === "provider_snapshot" ? "PROVIDER-LISTED snapshot" : "synthetic sample"} reference)`));
      if (c.providerIdentity) out.push(line("Provider identity:", `${c.providerIdentity.provider} ${c.providerIdentity.exchange}/${c.providerIdentity.segment}/${c.providerIdentity.instrument}${c.providerIdentity.securityId ? `, security id ${c.providerIdentity.securityId} (as supplied; column undocumented by provider)` : ", no security id supplied"}`));
      if (c.tickSizeRaw) out.push(line("Tick size (raw):", `${c.tickSizeRaw} (units not documented by the provider; not converted)`));
      out.push(line("Matched contract:", `${c.contractId ? `entry ${c.contractId}, ` : ""}expiry ${c.expiryDate}, lot size ${c.lotSize} (lot size comes only from the reference)`));
      if (c.verifiedAsOf) out.push(line("Entry verified as of:", c.verifiedAsOf), line("Entry source:", c.entrySource ?? "n/a"), line("Entry evidence note:", c.notes ?? "n/a"));
      break;
    }
  }
  if (master.reference) {
    const ref = master.reference;
    out.push(line("Reference source:", ref.source), line("Reference version:", ref.version));
    if (ref.collectedAsOf) out.push(line("Collected as of:", ref.collectedAsOf));
    out.push(line("Reference entries:", ref.entryCount === 0 && ref.kind === "manual_verified" ? "0 (MANUAL_REFERENCE_EMPTY)" : String(ref.entryCount ?? "n/a")));
    out.push(line("Reference synthetic:", ref.synthetic ? "YES - invented sample data, proves nothing about any real contract" : ref.kind === "provider_snapshot" ? "no (real provider-listed entries; still not live data and not exchange-verified)" : "no (manually verified entries; still not live data)"));
    if (ref.snapshot) {
      const sn = ref.snapshot;
      const ageDays = Math.floor((Date.now() - new Date(sn.retrievedAt).getTime()) / 86_400_000);
      out.push(line("Snapshot retrieved:", `${sn.retrievedAt} (${sn.retrievalTimeSource === "owner_supplied" ? "owner supplied" : "ESTIMATE from file modification time"})`), line("Snapshot age:", `${ageDays} day(s) at this run; no freshness threshold is defined, so none is applied`));
      out.push(line("Snapshot source URL:", sn.sourceUrl), line("Snapshot SHA-256:", sn.contentSha256), line("Importer/schema:", `${sn.importerVersion} / ${sn.snapshotSchemaVersion} (${sn.csvFormat})`));
    }
    out.push(line("WARNING:", ref.kind === "provider_snapshot" ? PROVIDER_LISTED_STATEMENT : ref.kind === "manual_verified" ? "a manual local reference is not live entitlement and does not prove current tradability." : "a local reference is not live entitlement and not a guarantee that the contract is currently tradable."));
  }
  return out;
}

function describePremium(p: PremiumLookup, provider: OptionsPremiumProvider): string[] {
  const out: string[] = [];
  const fmt = (n: number | undefined) => (n === undefined ? "n/a" : String(n));
  switch (p.status) {
    case "unavailable": out.push(line("Premium data:", "UNAVAILABLE (no premium data provider is configured)")); break;
    case "not_attempted": out.push(line("Premium data:", `NOT_ATTEMPTED (${p.reason})`)); break;
    case "not_found": out.push(line("Premium data:", "PREMIUM_DATA_NOT_FOUND (no exact match on underlying, strike, CE/PE and expiry; no nearest strike/expiry, no interpolation)")); break;
    case "sample_quote":
      out.push(line("Premium data:", "SAMPLE QUOTE (exact match; SYNTHETIC, not live market data)"));
      out.push(line("Sample quote:", `bid ${fmt(p.quote.bid)}, ask ${fmt(p.quote.ask)}, last ${fmt(p.quote.last)} (no view is given on whether this is good, cheap, expensive, probable or tradable)`));
      break;
  }
  const src = provider.source;
  if (src && p.status !== "not_attempted") {
    out.push(line("Premium source:", src.source), line("Premium version:", src.version), line("Premium collected:", src.collectedAsOf), line("Premium synthetic:", src.synthetic ? "YES - invented sample numbers" : "no"));
    out.push(line("Premium statement:", src.notLiveStatement));
  }
  return out;
}

/** Runs the preview and returns the text to print. Never throws for ordinary input; a thrown error is a tool failure. */
export async function renderOptionsPreview(
  input: string,
  master: OptionsContractMaster = loadManualReferenceMaster(),
  premiumProvider: OptionsPremiumProvider = unavailablePremiumProvider,
): Promise<string> {
  const analysis = analyzeTelegramText(input);
  const out: string[] = ["OPTIONS PREVIEW (offline, nothing stored or sent)", "", line("Input:", JSON.stringify(input)), line("Parser version:", TELEGRAM_PARSER_VERSION)];

  if (analysis.kind === "options_claim") {
    const assessment = await assessOptionsClaim(analysis.claim, master, premiumProvider);
    out.push(line("Status:", "RECOGNIZED options claim"), "", ...describeClaim(analysis.claim), "");
    out.push(...describeVerification(assessment.verification, master), ...describePremium(assessment.premium, premiumProvider));
    out.push(line("Assessment:", assessment.outcome), line("approvalPossible:", String(assessment.approvalPossible)), line("Level checks:", assessment.levelChecks));
    out.push("  Reasons:", ...assessment.reasons.map((r) => `    - ${r.code} [${r.severity}]: ${r.description}`));
  } else if (analysis.kind === "options_unsupported") {
    out.push(line("Status:", "UNSUPPORTED options-shaped input"), line("Raw symbol:", analysis.symbol), line("Detected form:", analysis.form));
    out.push(line("Assessment:", "not assessed - the underlying is not supported; it is not mapped, corrected or guessed"), line("approvalPossible:", "false"));
    out.push("  Reasons:", "    - underlying.unsupported_options_shape [insufficient]: strong options structure with an underlying other than NIFTY, BANKNIFTY or SENSEX");
  } else if (analysis.kind === "ambiguous") {
    out.push(line("Status:", "AMBIGUOUS - several directives; not merged or guessed"));
    out.push("  Directives:", ...analysis.directives.map((d) => `    - ${d.direction.toUpperCase()} ${d.symbol}`));
    out.push(line("Assessment:", "not assessed"), line("approvalPossible:", "false"));
  } else {
    out.push(line("Status:", "NOT AN OPTIONS MESSAGE - this preview handles options text only; no equity parsing is done here"), line("approvalPossible:", "false"));
  }
  out.push("", "No order submitted.");
  return out.join("\n");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let referencePath = DEFAULT_MANUAL_REFERENCE_PATH;
  let premiumPath: string | undefined;
  let useSample = false;
  let snapshotPath: string | undefined;
  let referenceGiven = false;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--reference") { referencePath = argv[++i] ?? ""; referenceGiven = true; }
    else if (argv[i] === "--sample-reference") useSample = true;
    else if (argv[i] === "--provider-snapshot") snapshotPath = argv[++i] ?? "";
    else if (argv[i] === "--premium") premiumPath = argv[++i] ?? "";
    else args.push(argv[i] ?? "");
  }
  const input = (args.length > 0 ? args.join(" ") : process.stdin.isTTY ? "" : await readStdin()).trim();
  if ([useSample, referenceGiven, snapshotPath !== undefined].filter(Boolean).length > 1) {
    console.error("usage error: --reference, --sample-reference and --provider-snapshot are mutually exclusive. Nothing was run.");
    return 2;
  }
  if (!input) {
    console.error('usage: npm run options:preview -- "<message text>"   (or pipe the text on stdin)\nExit 2: no input. Nothing was run.');
    return 2;
  }
  const master = snapshotPath !== undefined ? loadProviderSnapshotMaster(snapshotPath) : useSample ? loadSampleReferenceMaster() : loadManualReferenceMaster(referencePath);
  // Sample premium quotes are keyed to the synthetic sample contracts: used only with --sample-reference or an explicit --premium file.
  const premium = premiumPath !== undefined ? loadPremiumProvider(premiumPath) : useSample ? loadPremiumProvider() : unavailablePremiumProvider;
  console.log(await renderOptionsPreview(input, master, premium));
  return 0;
}

if (process.argv[1]?.endsWith("options-preview.ts")) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Reference-data errors name the offending field only; nothing else is printed.
      const detail = err instanceof Error && (err.name === "ReferenceFileError" || err.name === "PremiumFileError" || err.name === "ProviderSnapshotError") ? `: ${err.message}` : err instanceof Error ? ` (${err.name})` : "";
      console.error(`options preview FAILED to run (tool error, not an assessment)${detail}`);
      process.exit(1);
    },
  );
}
