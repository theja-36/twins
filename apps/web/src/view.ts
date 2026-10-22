/**
 * Pure view-model builder for the read-only options-result viewer. It only RESHAPES what the existing
 * GET /options-claims/:messageId endpoint returned: it never reparses a message, never reassesses a claim, never
 * attaches today's reference data, and never turns an unsupported/ambiguous record into a complete claim.
 */
export interface ViewRow { label: string; value: string }
export interface ViewSection { title: string; rows: ViewRow[] }
export interface ViewReason { code: string; severity: string; description: string }
export interface ViewVersion {
  parserVersion: string;
  kind: "claim" | "ambiguous" | "unsupported" | "unknown";
  kindLabel: string;
  banner: string;
  approvalPossible: false;
  recordedAt: string;
  sections: ViewSection[];
  reasons: ViewReason[];
  warnings: string[];
}
export interface ViewModel {
  messageId: string;
  versionCount: number;
  selectedParserVersion: string | null;
  notice: string;
  versions: ViewVersion[];
}

export const STORED_BANNER = "Stored assessment — not an order";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown, fallback = "n/a"): string => (typeof v === "string" && v.length > 0 ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : fallback);

function describeExpiry(e: Json | null): string[] {
  if (!e) return ["not recorded"];
  const day = e["day"], month = e["month"];
  switch (e["status"]) {
    case "missing": return ["missing - none stated, none inferred"];
    case "period_word": return [`period word "${str(e["word"])}" - does not identify a date, none resolved`];
    case "day_month": return [`day ${str(day)}, month ${str(month)} - year NOT stated, unresolved`];
    case "year_dependent": return [`day ${str(day)}, month ${str(month)} - 29 February without a year, unresolved`];
    case "year_two_digit": return [`day ${str(day)}, month ${str(month)}, year written as "${str(e["twoDigitYear"])}" - two-digit year left unresolved (no century inferred)`];
    case "full": return [`${str(e["year"])}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} as written - calendar-valid only, NOT proof that an exchange contract exists`];
    case "invalid": return [`as written "${str(e["raw"])}" - INVALID: ${str(e["reason"])}`];
    default: return [`unrecognised status "${str(e["status"])}"`];
  }
}

function describeEntry(e: Json | null): string {
  if (!e) return "not recorded";
  switch (e["type"]) {
    case "range": return `range ${str(e["low"])} to ${str(e["high"])} (a condition, not a fill)`;
    case "market": return "market / CMP, no price stated";
    case "unspecified": return "not stated";
    case "at": return `at ${str(e["price"])} (quoted entry, not a fill)`;
    default: return `${str(e["type"])} ${str(e["price"])} (a trigger condition, not a fill)`;
  }
}

function claimSection(c: Json): ViewSection[] {
  const targets = Array.isArray(c["targets"]) ? (c["targets"] as unknown[]).map((t) => String(t)) : [];
  const basis = c["levelBasis"];
  const [expiryFirst, ...expiryRest] = describeExpiry(obj(c["expiry"]));
  return [
    {
      title: "Parsed claim (unverified)",
      rows: [
        { label: "Underlying", value: str(c["underlying"]) + (c["underlyingAliasUsed"] === true ? ' (alias "BANK NIFTY" normalized)' : "") },
        { label: "Action", value: str(c["action"], "not stated") },
        { label: "Intent", value: c["intent"] === "long_entry_presumed" ? "long entry presumed from BUY (a presumption of the text)" : "UNRESOLVED (entry vs exit vs fresh short not known; fresh short entry unsupported)" },
        { label: "Strike", value: c["strike"] === null || c["strike"] === undefined ? (c["compactCodeUnrecognized"] === true ? "not decoded (compact code unrecognized)" : "not stated") : str(c["strike"]) },
        { label: "Option type", value: c["optionType"] ? str(c["optionType"]) : c["optionTypeConflict"] === true ? "conflict (both CE and PE stated)" : "not stated" },
        { label: "Expiry", value: expiryFirst ?? "" },
        ...expiryRest.map((r) => ({ label: "", value: r })),
        { label: "Entry condition", value: describeEntry(obj(c["entry"])) },
        { label: "Level basis", value: basis === "premium" || basis === "underlying" ? String(basis) : c["levelBasisConflict"] === true ? "UNSPECIFIED (conflicting markers)" : "UNSPECIFIED (values kept, not interpreted)" },
        { label: "Stop-loss", value: c["stopLoss"] === null || c["stopLoss"] === undefined ? "not stated" : str(c["stopLoss"]) },
        { label: "Targets (in order)", value: targets.length ? targets.join(", ") : "none stated" },
        { label: "Implied underlying view", value: `${str(c["impliedUnderlyingView"])} (informational; separate from action and level basis)` },
      ],
    },
  ];
}

function verificationSection(v: Json | null, premium: Json | null): ViewSection {
  const rows: ViewRow[] = [];
  if (!v) rows.push({ label: "Contract verification", value: "not assessed" });
  else {
    const status = String(v["status"]);
    const label = { unconfigured: "UNCONFIGURED", reference_empty: "MANUAL_REFERENCE_EMPTY", not_attempted: "NOT_ATTEMPTED", not_found: "NOT_FOUND", ambiguous: "AMBIGUOUS", verified: "FOUND" }[status] ?? status.toUpperCase();
    rows.push({ label: "Contract verification", value: label + (typeof v["reason"] === "string" ? ` (${v["reason"]})` : "") });
    const c = obj(v["contract"]);
    if (status === "verified" && c) {
      rows.push({ label: "Matched contract", value: `${c["contractId"] ? `entry ${str(c["contractId"])}, ` : ""}expiry ${str(c["expiryDate"])}, lot size ${str(c["lotSize"])} (lot size comes only from the reference)` });
      if (c["verifiedAsOf"]) rows.push({ label: "Entry verified as of", value: str(c["verifiedAsOf"]) }, { label: "Entry source", value: str(c["entrySource"]) }, { label: "Entry evidence note", value: str(c["notes"]) });
    }
    if (status === "ambiguous") rows.push({ label: "Candidates", value: str(v["candidates"]) });
  }
  if (!premium) rows.push({ label: "Premium data", value: "not assessed" });
  else {
    const status = String(premium["status"]);
    rows.push({ label: "Premium data", value: { unavailable: "UNAVAILABLE", not_attempted: "NOT_ATTEMPTED", not_found: "PREMIUM_DATA_NOT_FOUND", sample_quote: "SAMPLE QUOTE (synthetic, not live market data)" }[status] ?? status.toUpperCase() });
    const q = obj(premium["quote"]);
    if (q) rows.push({ label: "Sample quote", value: `bid ${str(q["bid"], "n/a")}, ask ${str(q["ask"], "n/a")}, last ${str(q["last"], "n/a")}` });
  }
  return { title: "Stored contract verification and premium lookup", rows };
}

function provenanceSection(p: Json | null): { section: ViewSection; warnings: string[] } {
  const warnings: string[] = [];
  const rows: ViewRow[] = [];
  const cm = obj(p?.["contractMaster"]);
  if (!cm || cm["configured"] !== true) {
    rows.push({ label: "Contract master used", value: "none configured at the time (the contract could not be verified)" });
  } else {
    rows.push({ label: "Contract master used", value: str(cm["name"]) });
    const ref = obj(cm["reference"]);
    if (ref) {
      rows.push({ label: "Reference kind", value: ref["kind"] === "manual_verified" ? "MANUAL VERIFIED REFERENCE" : ref["kind"] === "synthetic_sample" ? "SYNTHETIC SAMPLE" : ref["kind"] === "provider_snapshot" ? "PROVIDER SNAPSHOT (provider-listed only)" : str(ref["kind"]) });
      rows.push({ label: "Reference version", value: str(ref["version"]) }, { label: "Reference source", value: str(ref["source"]) });
      if (ref["collectedAsOf"]) rows.push({ label: "Collected as of", value: str(ref["collectedAsOf"]) });
      if (ref["entryCount"] !== undefined) rows.push({ label: "Reference entries", value: str(ref["entryCount"]) });
      if (ref["kind"] === "manual_verified") warnings.push("Manual local reference: not live entitlement and it does not prove current tradability.");
      const sn = obj(ref["snapshot"]);
      if (ref["kind"] === "provider_snapshot" && sn) {
        const ageDays = Math.floor((Date.now() - new Date(str(sn["retrievedAt"])).getTime()) / 86_400_000);
        rows.push({ label: "Snapshot retrieved", value: `${str(sn["retrievedAt"])} (${sn["retrievalTimeSource"] === "owner_supplied" ? "owner supplied" : "estimate from file time"})` }, { label: "Snapshot age", value: Number.isNaN(ageDays) ? "unknown" : `${ageDays} day(s) now; no freshness threshold is defined` });
        rows.push({ label: "Snapshot source URL", value: str(sn["sourceUrl"]) }, { label: "Snapshot SHA-256", value: str(sn["contentSha256"]) }, { label: "Importer / schema", value: `${str(sn["importerVersion"])} / ${str(sn["snapshotSchemaVersion"])}` });
        warnings.push("Provider-listed only: not exchange-independent verification, not live entitlement and not proof of current tradability.");
      }
      if (ref["synthetic"] === true || ref["kind"] === "synthetic_sample") warnings.push("SYNTHETIC SAMPLE reference: invented data that proves nothing about any real contract.");
    }
    if (cm["isTestFixture"] === true) warnings.push("TEST FIXTURE master: not a real reference.");
  }
  const pp = obj(p?.["premiumProvider"]);
  if (!pp || pp["configured"] !== true) rows.push({ label: "Premium provider used", value: "none configured" });
  else {
    rows.push({ label: "Premium provider used", value: str(pp["name"]) });
    const src = obj(pp["source"]);
    if (src?.["synthetic"] === true) warnings.push("SYNTHETIC SAMPLE premium data: not live market data.");
  }
  if (typeof p?.["note"] === "string") rows.push({ label: "Note", value: String(p["note"]) });
  return { section: { title: "Stored provenance (what was actually used)", rows }, warnings };
}

export function buildView(body: unknown): ViewModel {
  const b = obj(body);
  if (!b || !Array.isArray(b["claims"])) throw new Error("unexpected API response shape");
  const versions: ViewVersion[] = (b["claims"] as unknown[]).map((raw): ViewVersion => {
    const r = obj(raw) ?? {};
    const kindRaw = String(r["resultKind"]);
    const kind: ViewVersion["kind"] = kindRaw === "claim" || kindRaw === "ambiguous" || kindRaw === "unsupported" ? kindRaw : "unknown";
    const sections: ViewSection[] = [];
    const warnings: string[] = [];
    const claim = obj(r["claim"]);
    const detail = obj(r["detail"]);
    if (kind === "claim" && claim) sections.push(...claimSection(claim));
    else if (kind === "ambiguous") {
      const dirs = Array.isArray(detail?.["directives"]) ? (detail?.["directives"] as unknown[]) : [];
      sections.push({
        title: "Ambiguous: several directives (no complete claim was recorded)",
        rows: dirs.map((d, i) => ({ label: `Directive ${i + 1}`, value: `${str(obj(d)?.["direction"]).toUpperCase()} ${str(obj(d)?.["symbol"])}` })),
      });
    } else if (kind === "unsupported") {
      sections.push({
        title: "Unsupported options-shaped input (no complete claim was recorded)",
        rows: [{ label: "Raw symbol", value: str(detail?.["symbol"]) }, { label: "Detected form", value: str(detail?.["form"]) }, { label: "Underlying", value: "not mapped, corrected or guessed" }],
      });
    }
    const outcome = r["assessmentOutcome"];
    sections.push({
      title: "Stored assessment",
      rows: [
        { label: "Outcome", value: typeof outcome === "string" ? outcome : "not assessed (no complete claim)" },
        { label: "approvalPossible", value: "false" },
      ],
    });
    if (kind === "claim") sections.push(verificationSection(obj(r["verification"]), obj(r["premium"])));
    const prov = provenanceSection(obj(r["provenance"]));
    sections.push(prov.section);
    warnings.push(...prov.warnings);
    const reasons: ViewReason[] = (Array.isArray(r["reasons"]) ? (r["reasons"] as unknown[]) : []).map((x) => ({
      code: str(obj(x)?.["code"]), severity: str(obj(x)?.["severity"]), description: str(obj(x)?.["description"], ""),
    }));
    return {
      parserVersion: str(r["parserVersion"], "unknown"),
      kind,
      kindLabel: kind === "claim" ? "CLAIM (unverified)" : kind === "ambiguous" ? "AMBIGUOUS" : kind === "unsupported" ? "UNSUPPORTED" : "UNKNOWN",
      banner: STORED_BANNER,
      approvalPossible: false,
      recordedAt: str(r["createdAt"]),
      sections,
      reasons,
      warnings,
    };
  });
  return {
    messageId: str(b["messageId"]),
    versionCount: versions.length,
    selectedParserVersion: typeof b["selectedParserVersion"] === "string" ? b["selectedParserVersion"] : null,
    notice: str(b["notice"], STORED_BANNER),
    versions,
  };
}
