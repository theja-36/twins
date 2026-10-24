"""History pilot (read-only, bounded). Reads the newest messages of ONE approved channel with getChatHistory (the only module that uses it),
newest-first, stopping at HISTORY_MAX_MESSAGES messages or HISTORY_MAX_DAYS days, whichever is smaller. Two phases:
  dry-run  reads from Telegram only (never contacts the ingest endpoint) and prints counts, ids and dates - never any text - plus the exact
           parameters of the import;
  import   re-reads the SAME window, aborts BEFORE any write unless it matches what the owner confirmed (count, newest id, lower date bound),
           then posts api_history batches. It stops on the first rate limit or error; nothing is retried. Re-running is safe: the server
           de-duplicates by message id (and revision identity).
Never posts, edits, deletes, joins or marks anything as read."""
import datetime
import uuid

from .mapping import build_history_payload, map_message, server_message_id
from .service import EXIT_AUTH, EXIT_BLOCKED, EXIT_CHAT, EXIT_EGRESS, EXIT_OK, prepare_transport
from .session import AuthFailure, ChatUnavailable, Session, check_session_dir
from .tdlib import HISTORY_PAGE_LIMIT, CaptureError, FloodWait

HISTORY_MAX_MESSAGES = 50
HISTORY_MAX_DAYS = 7
HISTORY_MAX_PAGES = 6   # a runaway guard: 6 pages of at most 50 can never be needed for a 50-message window
IMPORT_BATCH_SIZE = 50
EXIT_WINDOW_MISMATCH = 3
EXIT_IMPORT_FAILED = 4


def read_window(session, chat_id, now_ts, max_messages=HISTORY_MAX_MESSAGES, max_days=HISTORY_MAX_DAYS, from_ts=None, to_id=None):
    """Raw TDLib messages, newest first. Bounds: at most `max_messages`, none older than `from_ts` (default now - max_days) and none newer than
    server message id `to_id`. TDLib may return fewer messages than asked, so pages are repeated (bounded) until a bound is reached."""
    if max_messages > HISTORY_MAX_MESSAGES or max_days > HISTORY_MAX_DAYS:
        raise CaptureError("internal error: history window exceeds the hard bounds")
    lower = from_ts if from_ts is not None else int(now_ts) - max_days * 86400
    selected, seen, from_id, pages = [], set(), 0, 0
    while len(selected) < max_messages and pages < HISTORY_MAX_PAGES:
        reply = session.request("getChatHistory", chat_id=chat_id, from_message_id=from_id, offset=0, limit=min(HISTORY_PAGE_LIMIT, max_messages), only_local=False)
        pages += 1
        page = reply.get("messages") if isinstance(reply, dict) else None
        page = [m for m in (page or []) if isinstance(m, dict) and isinstance(m.get("id"), int) and m["id"] not in seen]
        if not page:
            break
        reached_older = False
        for message in sorted(page, key=lambda m: m["id"], reverse=True):
            seen.add(message["id"])
            date = message.get("date")
            if not isinstance(date, int) or date < lower:
                reached_older = True
                continue
            sid = server_message_id(message["id"])
            if to_id is not None and sid is not None and sid > to_id:
                continue
            if len(selected) < max_messages:
                selected.append(message)
        if reached_older:
            break
        from_id = min(seen)
    selected.sort(key=lambda m: m["id"], reverse=True)
    return selected, pages


def summarize(messages):
    """Counts, ids and dates only. `importable` = messages the ingest endpoint would accept (they carry text); the worker's options-only gate
    may still decline some of them later."""
    ids, importable, reasons, edited, dates = [], [], {}, 0, []
    for message in messages:
        sid = server_message_id(message.get("id"))
        mapped, reason = map_message(message)
        if sid is not None:
            ids.append(sid)
        if isinstance(message.get("date"), int):
            dates.append(message["date"])
        if isinstance(message.get("edit_date"), int) and message["edit_date"] > 0:
            edited += 1
        if mapped is None:
            reasons[reason] = reasons.get(reason, 0) + 1
        else:
            importable.append(mapped)
    return {
        "total": len(messages), "with_text": len(importable), "no_text": len(messages) - len(importable), "edited": edited,
        "ids": sorted(ids), "oldest_id": min(ids) if ids else 0, "newest_id": max(ids) if ids else 0,
        "oldest_ts": min(dates) if dates else 0, "newest_ts": max(dates) if dates else 0, "reasons": reasons,
    }, importable


def _iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def run_history(args, cfg, transport, poster, log, state, clock, sleep, egress_check=None):
    """`args`: chat (int), dry_run (bool), from_ts / to_id / expect_count (import only). Returns the process exit code."""
    if args["chat"] not in cfg.chat_ids:
        log.alert("chat_not_in_allowlist")
        return EXIT_CHAT
    if clock() < state.blocked_until():
        log.alert("flood_block_active", blocked_until=int(state.blocked_until()))
        return EXIT_BLOCKED
    if egress_check is not None and not egress_check():
        state.record_alert("egress_unrestricted")
        log.alert("egress_unrestricted")
        return EXIT_EGRESS
    check_session_dir(cfg.session_dir)
    prepare_transport(transport, log)
    session = Session(transport, cfg, None, log, state, clock, sleep)
    try:
        session.ensure_ready(None)
        session.resolve_chats(only=args["chat"])  # member? broadcast channel? protected content off? (any problem stops here)
        now = int(clock())
        importing = not args["dry_run"]
        messages, pages = read_window(session, args["chat"], now, from_ts=args["from_ts"] if importing else None, to_id=args["to_id"] if importing else None)
        report, importable = summarize(messages)
        from_ts = args["from_ts"] if importing else now - HISTORY_MAX_DAYS * 86400
        log.log("history.window", mode="import" if importing else "dry_run", total=report["total"], with_text=report["with_text"], no_text=report["no_text"],
                edited=report["edited"], oldest_id=report["oldest_id"], newest_id=report["newest_id"], oldest_ts=report["oldest_ts"],
                newest_ts=report["newest_ts"], pages=pages, max_messages=HISTORY_MAX_MESSAGES, max_days=HISTORY_MAX_DAYS, from_ts=from_ts)
        log.log("history.ids", ids=report["ids"])
        if not importing:
            log.log("history.dry_run_done", expect_count=report["with_text"], from_ts=from_ts, newest_id=report["newest_id"])
            return EXIT_OK  # nothing was written anywhere
        if report["with_text"] != args["expect_count"]:
            log.alert("window_mismatch", count=report["with_text"], expect_count=args["expect_count"])
            return EXIT_WINDOW_MISMATCH  # aborted BEFORE any write: the window is not what the owner confirmed
        if not importable:
            log.log("history.nothing_to_import")
            return EXIT_OK
        batch_id = str(uuid.uuid4())
        accepted = duplicates = ignored = posts = 0
        observed = _iso(now)
        for i in range(0, len(importable), IMPORT_BATCH_SIZE):
            chunk = importable[i:i + IMPORT_BATCH_SIZE]
            try:
                status, retry_after, counts = poster.post_detail(build_history_payload(args["chat"], observed, chunk, batch_id))
            except OSError:
                log.alert("import_transport_error", batch=batch_id, count=posts)
                return EXIT_IMPORT_FAILED
            posts += 1
            if not 200 <= status < 300:
                log.alert("import_http_%d" % status if 100 <= status < 600 else "import_http_error", status=status, batch=batch_id, count=posts)
                return EXIT_IMPORT_FAILED  # a rate limit or any error stops the import; nothing is retried
            if counts:
                accepted += counts.get("accepted") or 0
                duplicates += counts.get("duplicates") or 0
                ignored += counts.get("ignored") or 0
        log.log("history.imported", batch=batch_id, batches=posts, with_text=len(importable), accepted=accepted, duplicates=duplicates, ignored=ignored)
        return EXIT_OK
    except FloodWait as error:
        until = state.set_blocked(error.seconds)
        log.alert("flood_wait", blocked_until=until)
        state.record_alert("flood_wait")
        return EXIT_BLOCKED  # stop on the first rate limit
    except AuthFailure as error:
        state.record_alert(error.reason)
        log.alert(error.reason)
        return EXIT_AUTH
    except ChatUnavailable as error:
        state.record_alert(error.reason)
        log.alert(error.reason)
        return EXIT_CHAT
    finally:
        session.close()
