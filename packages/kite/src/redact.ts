const KEYED = /\b(api_key|api_secret|access_token|request_token|checksum|authorization|enctoken)\b(["'\s:=]+)(?:token\s+)?[^\s"',;&}]+/gi;

/** Removes every known secret value and any `key=value` / `"key": "value"` for credential-looking keys. Output is bounded. */
export function redact(text: string, secrets: readonly string[] = [], max = 200): string {
  let out = text;
  for (const s of secrets) if (s.length >= 6) out = out.split(s).join("[REDACTED]");
  out = out.replace(KEYED, (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`);
  return out.length > max ? `${out.slice(0, max)}...` : out;
}
