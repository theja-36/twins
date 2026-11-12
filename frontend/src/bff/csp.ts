/**
 * Content-Security-Policy with a per-request nonce. No inline script or style without the nonce, no eval in production, no third-party origin (fonts are self-hosted by next/font),
 * the API is never a browser target (`connect-src 'self'`), the page cannot be framed, and forms post only to this origin.
 */
export function buildCsp(nonce: string, o: { dev: boolean; hostMode: boolean }): string {
  const d: string[] = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${o.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'", // React style attributes only; no style element or script runs from attributes
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
  ];
  if (o.hostMode) d.push("upgrade-insecure-requests");
  return d.join("; ");
}
export function newNonce(): string { const b = new Uint8Array(16); crypto.getRandomValues(b); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); }
