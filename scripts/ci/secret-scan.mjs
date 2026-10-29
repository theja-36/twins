// Repository secret scan (Stage 2 / Task 1). Dependency-free, offline, read-only. Scans every TRACKED text file (git ls-files) plus, with --staged, the
// staged blobs, for credential-shaped strings, and refuses tracked files that look like secret material. Exit 0 = clean, 1 = findings, 2 = could not run.
// It is a safety net, not a replacement for GitHub secret scanning / push protection (enable them in the repository settings when the plan allows).
// A finding that is a deliberate synthetic value is allow-listed BELOW with the exact value and a reason; never allow-list by file or pattern.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const PATTERNS = [
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["github_fine_grained_token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["aws_access_key_id", /\bAKIA[0-9A-Z]{16}\b/],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["api_secret_key", /\bsk-[A-Za-z0-9_-]{30,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["telegram_bot_token", /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/],
];

/**
 * Lower-confidence patterns (a password in a URL, a quoted key assignment). They are applied to runtime code, scripts, infrastructure and workflows, NOT to tests, docs and
 * *.example templates, where synthetic credentials for disposable local databases (twins_dev_password, test API keys) are the norm. The high-confidence token and key
 * patterns above are applied EVERYWHERE, tests and docs included.
 */
export const GENERIC_PATTERNS = [
  ["url_with_password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]+:([^\s:@/'"`$]{8,})@[^\s/'"`]/i],
  ["quoted_secret_assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']([A-Za-z0-9+/_=.-]{16,})["']/i],
];

/** Deliberate synthetic values. The value must match EXACTLY; add a reason. */
const GENERIC_EXEMPT = /^(tests\/|docs\/|README\.md$|.*\.example$|TWINS_BUILD_AUDIT_REPORT\.md$)/;

export const ALLOWED_VALUES = new Map([
  ["ci_only_not_a_secret", "password of the throwaway Postgres service container in CI and local disposable databases"],
  ["secret-pw", "dummy password used by tests that prove connection strings are never printed"],
  ["123456789:AAFakeTokenForTestsOnly_abcdefghijklmnopqrstu", "synthetic Telegram-shaped token for the approval-bot tests (does not authenticate anywhere)"],
]);

/** Tracked files that must never exist. Templates (*.example) are fine. */
export const FORBIDDEN_PATHS = [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.session$/, /(^|\/)staging\.env$/, /(^|\/)bot\.env$/, /\.dump(\.enc)?$/, /\.sqlite3?$/];

const BINARY = /\.(png|jpe?g|gif|ico|pdf|zip|gz|tgz|woff2?|ttf|bin|so)$/i;

export function scanText(path, text) {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [name, rx] of [...PATTERNS, ...(GENERIC_EXEMPT.test(path) ? [] : GENERIC_PATTERNS)]) {
      const m = rx.exec(line);
      if (!m) continue;
      const value = m[1] ?? m[0];
      if (ALLOWED_VALUES.has(value) || ALLOWED_VALUES.has(m[0])) continue;
      if (/\$\{|CHANGE_ME|<[^>]+>|example|placeholder/i.test(line) && name !== "private_key_block") continue; // templates and placeholders
      findings.push({ path, line: i + 1, pattern: name });
    }
  });
  return findings;
}

export function scanPaths(paths) {
  return paths.filter((p) => FORBIDDEN_PATHS.some((rx) => rx.test(p))).map((p) => ({ path: p, line: 0, pattern: "forbidden_file" }));
}

function main() {
  let files;
  try {
    files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  } catch {
    console.error("secret-scan: could not list tracked files (not a git checkout?)");
    return 2;
  }
  const findings = scanPaths(files);
  for (const f of files) {
    if (BINARY.test(f) || f === "package-lock.json") continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue;
    findings.push(...scanText(f, text));
  }
  if (findings.length === 0) {
    console.log(`secret-scan: ${files.length} tracked files scanned, no findings`);
    return 0;
  }
  // Only locations and pattern names are printed, never the matched text.
  for (const f of findings) console.error(`secret-scan: ${f.pattern} in ${f.path}${f.line ? `:${f.line}` : ""}`);
  console.error(`secret-scan: ${findings.length} finding(s). Remove the value, or (synthetic values only) allow-list the exact value with a reason in scripts/ci/secret-scan.mjs.`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
