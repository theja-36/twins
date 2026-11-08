// Usage: node scripts/product/tracker.mjs check|render|set <ID> <STATUS> [--evidence "text"]... [--blocker "text"]...
import { readFileSync, writeFileSync } from "node:fs";
import { render, summary, validate, STATUSES } from "./trackerLib.mjs";
const J = "docs/product/tracker.json", M = "docs/product/IMPLEMENTATION_TRACKER.md";
const [cmd, ...rest] = process.argv.slice(2);
const t = JSON.parse(readFileSync(J, "utf8"));
if (cmd === "set") {
  const [id, status] = rest; const r = t.requirements.find((x) => x.id === id);
  if (!r || !STATUSES.includes(status)) { console.error("unknown id or status"); process.exit(2); }
  r.status = status;
  for (let i = 2; i < rest.length; i += 2) { if (rest[i] === "--evidence") r.evidence.push(rest[i + 1]); else if (rest[i] === "--blocker") r.blockers.push(rest[i + 1]); }
  const errs = validate(t); if (errs.length) { console.error(errs.join("\n")); process.exit(1); }
  writeFileSync(J, JSON.stringify(t, null, 1) + "\n"); writeFileSync(M, render(t)); console.log(`${id} -> ${status}`);
} else if (cmd === "render") { writeFileSync(M, render(t)); console.log("rendered", M); }
else if (cmd === "check") { const e = validate(t); if (e.length) { console.error(e.join("\n")); process.exit(1); } console.log("tracker ok", Object.fromEntries(Object.entries(summary(t)).map(([k, v]) => [k, v.total]))); }
else { console.error("usage: tracker.mjs check|render|set"); process.exit(2); }
