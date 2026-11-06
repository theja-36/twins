#!/usr/bin/env bash
# Sets one provider API key in the host-only providers.env. Installed as /opt/twins-staging/twins-set-provider-key.sh (0750 root).
# The key is read from STANDARD INPUT (one line). It is never an argument, never echoed, never logged, and the only things printed are non-secret facts.
#   printf '%s' "$KEY" | ssh hostinger-vps /opt/twins-staging/twins-set-provider-key.sh              (FRED, the default)
#   printf '%s' "$KEY" | ssh hostinger-vps /opt/twins-staging/twins-set-provider-key.sh marketaux     (Marketaux; unused until activation, D-109)
# The only argument allowed is the provider name (fred or marketaux), never a key. Only that provider's line (TWINS_FRED_API_KEY or TWINS_MARKETAUX_API_KEY) is replaced; every other line of the file is kept. The file is replaced atomically, mode 600, owner root (the user compose runs as).
set -euo pipefail
set +x
umask 077
FILE="${PROVIDERS_ENV_FILE:-/opt/twins-staging/infrastructure/staging/providers.env}"
PROVIDER="${1:-fred}"
case "$PROVIDER" in
  fred) VAR="TWINS_FRED_API_KEY"; LABEL="FRED" ;;
  marketaux) VAR="TWINS_MARKETAUX_API_KEY"; LABEL="Marketaux" ;;
  *) echo "usage: [fred|marketaux]; the key itself is read from standard input, never an argument" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: [fred|marketaux]; the key itself is read from standard input, never an argument" >&2; exit 2; }
KEY=""
IFS= read -r -t 60 KEY || [ -n "$KEY" ] || { echo "No key was received (nothing changed)." >&2; exit 2; }
KEY="${KEY%$'\r'}"
if ! [[ "$KEY" =~ ^[A-Za-z0-9]{16,64}$ ]]; then
  echo "That does not look like a ${LABEL} API key (expected about 32 letters and digits, no spaces). Nothing was changed." >&2
  exit 3
fi
dir="$(dirname "$FILE")"
[ -d "$dir" ] || { echo "The folder for providers.env does not exist (nothing changed)." >&2; exit 4; }
tmp="$(mktemp "$FILE.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
kept=0
if [ -f "$FILE" ]; then
  grep -v "^${VAR}=" "$FILE" > "$tmp" || true   # keep every other line (grep exits 1 when nothing is left)
  kept="$(wc -l < "$tmp" | tr -d ' ')"
fi
printf '%s=%s\n' "$VAR" "$KEY" >> "$tmp"        # printf is a shell builtin: the key is not in any process argument
len="${#KEY}"
unset KEY
chmod 600 "$tmp"
if [ "$(id -u)" -eq 0 ]; then chown root:root "$tmp"; fi
mv -f "$tmp" "$FILE"
trap - EXIT
mode="$(stat -c '%a' "$FILE" 2>/dev/null || stat -f '%Lp' "$FILE")"
owner="$(stat -c '%U' "$FILE" 2>/dev/null || stat -f '%Su' "$FILE")"
echo "OK: the ${LABEL} key was saved to providers.env (key length ${len}, file mode ${mode}, owner ${owner}, other settings kept: ${kept} line(s))."
