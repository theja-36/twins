#!/usr/bin/env bash
# Resolves the numeric chat_id of the dedicated TWINS operational ALERT chat and stores ONLY that id in the staging env file (never printed in full, never logged).
# Prerequisite (owner): create a Telegram group (or channel) for operational alerts, add the TWINS approval bot to it (as admin for a channel), and send any message in it
# (for a private chat with the bot: send /start). The bot's pending updates are then read ONCE with getUpdates (read-only; the approval bot is inactive and does not poll).
#   twins-telegram-resolve-chat.sh --env-file <staging.env> --bot-env <bot.env> [--title <substring of the chat title>] [--list]
# Exit: 0 resolved (id written), 3 no unique candidate (candidates are listed with MASKED ids), 2 usage/config error, 1 Telegram error.
# The bot token is read from the bot env file, handed to curl through a descriptor (never argv) and never printed. API base can be overridden ONLY for tests (TELEGRAM_API_BASE).
set -uo pipefail
ENV_FILE=""; BOT_ENV=""; TITLE=""; LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --bot-env) BOT_ENV="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --list) LIST=1; shift ;;
    *) echo '{"level":"error","event":"resolve.usage"}'; exit 2 ;;
  esac
done
[ -n "$ENV_FILE" ] && [ -w "$ENV_FILE" ] && [ -r "$BOT_ENV" ] || { echo '{"level":"error","event":"resolve.config","reason":"env files missing or not writable"}'; exit 2; }
[[ "$TITLE" =~ ^[A-Za-z0-9\ ._-]{0,60}$ ]] || { echo '{"level":"error","event":"resolve.config","reason":"bad title"}'; exit 2; }
BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"
TOKEN="$(sed -n 's/^TWINS_BOT_TOKEN=//p' "$BOT_ENV" | tail -1 | sed 's/^"\(.*\)"$/\1/')"
[[ "$TOKEN" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,60}$ ]] || { echo '{"level":"error","event":"resolve.config","reason":"bot token not found or malformed"}'; exit 2; }
RESP="$(curl -sS --max-time 20 -G -K <(printf 'url = "%s/bot%s/getUpdates"\n' "$BASE" "$TOKEN") --data-urlencode 'allowed_updates=["message","channel_post","my_chat_member"]' --data-urlencode 'limit=100' 2>/dev/null)" || { echo '{"level":"error","event":"resolve.telegram","reason":"request failed"}'; exit 1; }
RESULT="$(printf '%s' "$RESP" | TITLE="$TITLE" LIST="$LIST" ENV_FILE="$ENV_FILE" python3 -c '
import json, os, re, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(json.dumps({"level":"error","event":"resolve.telegram","reason":"invalid response"})); sys.exit(1)
if not d.get("ok"):
    print(json.dumps({"level":"error","event":"resolve.telegram","reason":"telegram refused the request","errorCode": d.get("error_code")})); sys.exit(1)
chats = {}
for u in d.get("result", []):
    for key in ("message", "channel_post", "my_chat_member"):
        c = (u.get(key) or {}).get("chat")
        if c and isinstance(c.get("id"), int):
            chats[c["id"]] = {"type": c.get("type", "?"), "title": str(c.get("title") or c.get("username") or c.get("first_name") or "")[:60]}
title = os.environ["TITLE"].lower()
cands = [(i, c) for i, c in chats.items() if (not title or title in c["title"].lower())]
mask = lambda i: "..." + str(abs(i))[-4:]
if os.environ["LIST"] == "1" or len(cands) != 1:
    for i, c in cands:
        print(json.dumps({"event": "resolve.candidate", "chat": mask(i), "type": c["type"], "title": re.sub(r"[^A-Za-z0-9 ._-]", "?", c["title"])}))
    print(json.dumps({"event": "resolve.result", "candidates": len(cands), "written": False}))
    sys.exit(0 if os.environ["LIST"] == "1" else 3)
(cid, c), = cands
path = os.environ["ENV_FILE"]
lines = open(path).read().split("\n")
out, done = [], False
for l in lines:
    if l.startswith("TWINS_ALERT_TELEGRAM_CHAT_ID="):
        out.append("TWINS_ALERT_TELEGRAM_CHAT_ID=%d" % cid); done = True
    else:
        out.append(l)
if not done:
    while out and out[-1] == "": out.pop()
    out.append("TWINS_ALERT_TELEGRAM_CHAT_ID=%d" % cid); out.append("")
open(path, "w").write("\n".join(out))
print(json.dumps({"event": "resolve.result", "candidates": 1, "written": True, "chat": mask(cid), "type": c["type"], "title": re.sub(r"[^A-Za-z0-9 ._-]", "?", c["title"])}))
')"
code=$?
printf '%s\n' "$RESULT"
if [ "$code" -eq 0 ] || [ "$code" -eq 3 ]; then exit "$code"; fi
exit 1
