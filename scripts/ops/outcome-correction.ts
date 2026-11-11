/**
 * Owner-run, audited CORRECTION of a FINAL outcome attribution (Stage 08 A4). An attribution is append-only evidence; this is the one controlled way to supersede it, and it can only do what the attribution code itself does:
 * re-derive the record from the position and the trade outcome that are CURRENTLY recorded, as a NEW VERSION that names the previous one. It cannot set a value, it cannot edit or delete the original (the database refuses both), and it
 * contains no SQL of its own: every read and write goes through the typed stores, and the write is one transaction that also records the audit event.
 *
 *   outcome-correction --user <owner uuid> --attribution <attribution uuid> --reason "<why, 10-300 chars>" --evidence <ref> [--actor <name>] [--confirm <token>]
 *
 *   --evidence  a reference to the evidence for the correction, e.g. ticket:OPS-123, doc:docs/product/NOTE.md#s2, incident:2031-01-06-fill, audit:<uuid>, commit:<sha>, run:<id>
 *   DEFAULT IS A DRY RUN: it prints exactly what would be written and a confirmation token. Writing needs the SAME command again with --confirm <token>; the token is bound to the owner, the attribution, the reason, the evidence and the
 *   proposed record, so a changed plan (or a different request) is refused. Repeating a confirmed request changes nothing (ALREADY_APPLIED); two concurrent confirmations write one version.
 *
 * Authorisation: the command runs on the host (the same operator model as decision-control), names the OWNER explicitly, and refuses unless that owner is an active user who owns the attribution (another user's attribution is reported as not found),
 * the attribution is PAPER, FINAL and the latest version of its position. Exit codes: 0 ok (dry run, written, no change, already applied), 1 failure, 2 usage error, 3 refused. The connection string is never printed.
 */
import { pathToFileURL } from "node:url";
import { createBoundedDb, getAttributionById, insertCorrectionWithAudit, isUserActive, latestAttributionForPosition, loadAttributionFacts, type NewAttribution } from "../../packages/database/src/index";
import { enforceLiveTradingGuard } from "../../packages/config/src/liveGuard";
import { buildCorrection, canonicalJson, sha256 } from "../../packages/outcomes/src/index";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EVIDENCE = /^(ticket|doc|incident|audit|commit|run):[A-Za-z0-9_.\-/#]{2,160}$/;
const ACTOR = /^[A-Za-z0-9_.@-]{1,60}$/;
const ALLOWED = new Set(["user", "attribution", "reason", "evidence", "actor", "confirm"]);
const USAGE = 'usage: outcome-correction --user <owner uuid> --attribution <attribution uuid> --reason "<10-300 chars>" --evidence <ticket|doc|incident|audit|commit|run>:<ref> [--actor <name>] [--confirm <token>]';
function flags(argv: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) { const k = argv[i], v = argv[i + 1]; if (!k?.startsWith("--") || v === undefined || v.startsWith("--") || !ALLOWED.has(k.slice(2)) || k.slice(2) in o) throw new Error("usage"); o[k.slice(2)] = v; }
  return o;
}
/** The fields a correction may change, compared old to new (names only: what differs, never the values themselves, in the log). */
const COMPARED: Array<keyof NewAttribution> = ["finality", "dataSource", "grossPnl", "costs", "netPnl", "exitPrice", "rMultiple", "riskAmount", "holdingSeconds", "exitReason", "dataQuality", "missing", "confidenceScore", "trade", "regime", "predicted"];

export async function main(argv: string[], env: Record<string, string | undefined> = process.env, out: (l: string) => void = console.log, err: (l: string) => void = console.error): Promise<number> {
  let f: Record<string, string>;
  try { f = flags(argv); } catch { err(USAGE); return 2; }
  const userId = f["user"] ?? "", attributionId = f["attribution"] ?? "", reason = (f["reason"] ?? "").trim(), evidence = f["evidence"] ?? "", actor = f["actor"] ?? "operator";
  if (!UUID.test(userId) || !UUID.test(attributionId)) { err(`${USAGE}\n--user and --attribution must be UUIDs`); return 2; }
  if (reason.length < 10 || reason.length > 300) { err(`${USAGE}\n--reason is mandatory and must be 10-300 characters`); return 2; }
  if (!EVIDENCE.test(evidence)) { err(`${USAGE}\n--evidence is mandatory and must look like ticket:OPS-123, doc:<path>#<section>, incident:<id>, audit:<id>, commit:<sha> or run:<id>`); return 2; }
  if (!ACTOR.test(actor)) { err(`${USAGE}\n--actor must be 1-60 characters of letters, digits, . _ @ -`); return 2; }
  const url = env["DATABASE_URL"]; if (!url) { err("DATABASE_URL is not set"); return 1; }
  const h = createBoundedDb(url, { max: 3, idleTimeoutMillis: 5000 });
  try {
    if (!(await isUserActive(h.db, userId))) { err("refused: the named owner is not an active user"); return 3; }
    const prev = await getAttributionById(h.db, userId, attributionId); // owner-scoped: another user's attribution is simply not found
    if (!prev) { err("refused: no such attribution for this owner"); return 3; }
    const latest = await latestAttributionForPosition(h.db, userId, prev.paperPositionId);
    if (!latest) { err("refused: the position has no attribution"); return 3; }
    const marker = `correction:${evidence}`;
    if (latest.id !== prev.id) {
      if (latest.supersedesId === prev.id && (latest.correctionReason ?? "").includes(reason) && (latest.evidenceRefs as string[]).includes(marker)) { out(JSON.stringify({ result: "ALREADY_APPLIED", attributionId: prev.id, appliedVersion: latest.version, appliedAttributionId: latest.id })); return 0; }
      err(`refused: attribution ${prev.id} (version ${prev.version}) is not the latest version of its position (version ${latest.version} exists); name the latest version`); return 3;
    }
    if (prev.mode !== "PAPER") { err("refused: only PAPER attributions exist and can be corrected"); return 3; }
    if (prev.finality !== "FINAL") { err("refused: only a FINAL attribution is corrected; a PARTIAL one is superseded automatically by the learning cycle"); return 3; }
    const facts = await loadAttributionFacts(h.db, userId, prev.paperPositionId);
    if (!facts) { err("refused: the position or its decision is no longer readable for this owner"); return 3; }
    let proposed: NewAttribution | null;
    try { proposed = buildCorrection(facts, prev, `${reason} (evidence ${evidence}; operator ${actor})`); } catch (e) { err(`refused: ${e instanceof RangeError ? e.message : "the correction cannot be built"}`); return 3; }
    if (!proposed) { out(JSON.stringify({ result: "NO_CHANGE", attributionId: prev.id, note: "re-deriving the record from the current evidence gives the same record: nothing is written" })); return 0; }
    const record: NewAttribution = { ...proposed, evidenceRefs: [...new Set([...proposed.evidenceRefs, marker])].sort() };
    const changes = COMPARED.filter((k) => canonicalJson((prev as unknown as Record<string, unknown>)[k]) !== canonicalJson((record as unknown as Record<string, unknown>)[k])).map(String);
    const token = sha256(canonicalJson({ userId, attributionId: prev.id, version: prev.version, reason, evidence, actor, record: Object.fromEntries(COMPARED.map((k) => [k, record[k]])) })).slice(0, 16);
    const plan = { owner: userId, attributionId: prev.id, paperPositionId: prev.paperPositionId, currentVersion: prev.version, newVersion: record.version, changes, reason, evidence, actor };
    if (f["confirm"] === undefined) { out(JSON.stringify({ result: "DRY_RUN", written: false, ...plan, confirmToken: token, next: "repeat the same command with --confirm <token> to write this version" })); return 0; }
    if (f["confirm"] !== token) { err("refused: the confirmation token does not match this request and the current evidence (run the dry run again)"); return 3; }
    const id = await insertCorrectionWithAudit(h.db, userId, record, { actor, reason, evidence, previousId: prev.id, previousVersion: prev.version, changes });
    if (id === null) { out(JSON.stringify({ result: "ALREADY_APPLIED", attributionId: prev.id, note: "that version already exists (a repeated or concurrent confirmation); nothing was written" })); return 0; }
    out(JSON.stringify({ result: "WRITTEN", written: true, ...plan, newAttributionId: id })); return 0;
  } finally { await h.close().catch(() => undefined); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { enforceLiveTradingGuard("outcome-correction"); main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(`failed: ${e instanceof Error ? e.name : "Error"}`); process.exit(1); }); }
