// Pure helpers for docs/product/tracker.json: validation rules and Markdown rendering. Used by scripts/product/tracker.mjs and the unit tests.
export const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "IMPLEMENTED", "BLOCKED", "VERIFIED"];
const MODULES = Array.from({ length: 16 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);

/** Returns a list of rule violations (empty = valid). */
export function validate(t) {
  const errs = [];
  const seen = new Set();
  for (const r of t.requirements) {
    if (seen.has(r.id)) errs.push(`duplicate id ${r.id}`);
    seen.add(r.id);
    if (!STATUSES.includes(r.status)) errs.push(`${r.id}: invalid status ${r.status}`);
    if ((r.status === "VERIFIED" || r.status === "IMPLEMENTED") && r.evidence.length === 0) errs.push(`${r.id}: ${r.status} needs evidence`);
    if (r.status === "BLOCKED" && r.blockers.length === 0) errs.push(`${r.id}: BLOCKED needs a blocker`);
    for (const k of ["module", "feature", "existing", "change", "stage"]) if (typeof r[k] !== "string" || r[k] === "") errs.push(`${r.id}: missing ${k}`);
    for (const k of ["packages", "database", "api", "screens", "dependencies", "evidence", "blockers"]) if (!Array.isArray(r[k])) errs.push(`${r.id}: ${k} must be a list`);
  }
  for (const m of MODULES) if (!t.requirements.some((r) => r.module === m)) errs.push(`module ${m} has no requirements`);
  for (let i = 1; i <= 12; i++) if (!seen.has(`A${String(i).padStart(2, "0")}`)) errs.push(`agent A${String(i).padStart(2, "0")} missing`);
  if (!seen.has("A13")) errs.push("options-risk mapping (A13) missing");
  for (let i = 1; i <= 30; i++) if (!seen.has(`S${String(i).padStart(2, "0")}`)) errs.push(`screen S${String(i).padStart(2, "0")} missing`);
  return errs;
}

export function summary(t) {
  const by = {};
  for (const r of t.requirements) { const m = (by[r.module] ??= { name: r.moduleName, total: 0 }); m.total++; m[r.status] = (m[r.status] ?? 0) + 1; }
  return by;
}

export function render(t) {
  const by = summary(t);
  const cell = (s) => String(s ?? "").replaceAll("|", "/").replaceAll("\n", " ");
  let md = "# TWINS implementation tracker\n\n> GENERATED from `docs/product/tracker.json` by `node scripts/product/tracker.mjs render`. Edit the JSON, never this file. Rules (enforced by `tests/unit/product/tracker.test.ts`): IMPLEMENTED and VERIFIED need evidence, BLOCKED needs a blocker, and VERIFIED is reserved for evidence gathered by the testing stage.\n\n";
  md += `Requirements: **${t.requirements.length}**. ` + STATUSES.map((s) => `${s}: ${t.requirements.filter((r) => r.status === s).length}`).join(" · ") + "\n\n## Summary by module\n\n| Module | Name | Total | " + STATUSES.join(" | ") + " |\n|---|---|---|" + STATUSES.map(() => "---").join("|") + "|\n";
  for (const [k, v] of Object.entries(by)) md += `| ${k} | ${cell(v.name)} | ${v.total} | ` + STATUSES.map((s) => v[s] ?? 0).join(" | ") + " |\n";
  for (const k of Object.keys(by)) {
    md += `\n## ${k} — ${by[k].name}\n\n| ID | Area | Feature | Existing implementation | Stage | Status | Evidence | Blockers |\n|---|---|---|---|---|---|---|---|\n`;
    for (const r of t.requirements.filter((x) => x.module === k)) md += `| ${r.id} | ${cell(r.area)} | ${cell(r.feature)} | ${cell(r.existing)} | ${r.stage} | ${r.status} | ${cell(r.evidence.join("; "))} | ${cell(r.blockers.join("; "))} |\n`;
  }
  return md;
}
