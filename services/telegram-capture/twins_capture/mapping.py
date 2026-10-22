"""TDLib objects -> the internal ingest payload (apps/api/src/internalIngestValidation.ts). Text is carried ONLY inside the payload that is
sent to the internal endpoint; nothing here logs, prints or raises with content."""
import re

SERVER_ID_SHIFT = 20  # TDLib message ids of server messages are server_message_id << 20
MAX_TEXT = 20000
MAX_ENTITIES = 500
_SNAKE = re.compile(r"(?<!^)(?=[A-Z])")
_TYPE = re.compile(r"^[A-Za-z]{1,60}\Z")


def server_message_id(tdlib_id):
    """The Telegram server message id (what Bot API and the database use), or None for local/scheduled ids."""
    if isinstance(tdlib_id, bool) or not isinstance(tdlib_id, int) or tdlib_id <= 0 or tdlib_id % (1 << SERVER_ID_SHIFT) != 0:
        return None
    return tdlib_id >> SERVER_ID_SHIFT


def _snake(name, prefix):
    if not isinstance(name, str) or not _TYPE.match(name) or not name.startswith(prefix):
        return None
    rest = name[len(prefix):]
    return _SNAKE.sub("_", rest).lower() if rest else None


def _entities(formatted):
    out = []
    items = formatted.get("entities") if isinstance(formatted, dict) else None
    if not isinstance(items, list):
        return out
    for item in items[:MAX_ENTITIES]:
        if not isinstance(item, dict):
            continue
        kind = item.get("type") if isinstance(item.get("type"), dict) else {}
        name = _snake(kind.get("@type"), "textEntityType")
        offset, length = item.get("offset"), item.get("length")
        if name is None or not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in (offset, length)):
            continue
        entity = {"type": name[:40], "offset": offset, "length": length}
        url = kind.get("url")
        if isinstance(url, str) and 0 < len(url) <= 2048:
            entity["url"] = url
        language = kind.get("language")
        if isinstance(language, str) and 0 < len(language) <= 40:
            entity["language"] = language
        out.append(entity)
    return out


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def map_message(message):
    """Returns (payload_message, reason). payload_message is None when the message must not be sent (reason says why, content-free)."""
    if not isinstance(message, dict):
        return None, "bad_shape"
    server_id = server_message_id(message.get("id"))
    if server_id is None:
        return None, "not_a_server_message"
    date = message.get("date")
    if isinstance(date, bool) or not isinstance(date, int) or date <= 0:
        return None, "bad_date"
    content = message.get("content") if isinstance(message.get("content"), dict) else {}
    ctype = content.get("@type")
    if ctype == "messageText":
        formatted = content.get("text")
        media = None
    else:
        formatted = content.get("caption")  # photos, videos, documents ...: the caption is the text
        kind = _snake(ctype, "message")
        media = {"kind": kind[:40]} if kind else None
    text = formatted.get("text") if isinstance(formatted, dict) else None
    if not isinstance(text, str) or not text.strip():
        return None, "no_text"
    if len(text) > MAX_TEXT:
        return None, "text_too_long"
    out = {"id": server_id, "date": date, "text": text}
    edit_date = message.get("edit_date")
    if isinstance(edit_date, int) and not isinstance(edit_date, bool) and edit_date >= date and edit_date > 0:
        out["editDate"] = edit_date
    entities = _entities(formatted)
    if entities:
        out["entities"] = entities
    if media:
        out["media"] = media
    info = message.get("interaction_info") if isinstance(message.get("interaction_info"), dict) else {}
    views, forwards = _count(info.get("view_count")), _count(info.get("forward_count"))
    if views is not None:
        out["views"] = views
    if forwards is not None:
        out["forwards"] = forwards
    signature = message.get("author_signature")
    if isinstance(signature, str) and 0 < len(signature) <= 128:
        out["authorSignature"] = signature
    return out, None


def classify_update(update, allowed_chats):
    """A TDLib update -> a list of actions for the approved chats ONLY. Everything else (other chats, other kinds) yields nothing."""
    if not isinstance(update, dict):
        return []
    kind = update.get("@type")
    if kind == "updateNewMessage":
        message = update.get("message")
        if isinstance(message, dict) and message.get("chat_id") in allowed_chats:
            return [{"action": "new", "chat_id": message["chat_id"], "message": message}]
    elif kind == "updateMessageEdited":
        mid = server_message_id(update.get("message_id"))
        if update.get("chat_id") in allowed_chats and mid is not None:
            return [{"action": "edited", "chat_id": update["chat_id"], "tdlib_message_id": update["message_id"]}]
    elif kind == "updateDeleteMessages":
        ids = update.get("message_ids")
        # only permanent deletions seen by the server; a cache eviction is not a deletion
        if update.get("chat_id") in allowed_chats and update.get("is_permanent") is True and update.get("from_cache") is not True and isinstance(ids, list):
            server_ids = sorted({server_message_id(i) for i in ids if server_message_id(i) is not None})
            if server_ids:
                return [{"action": "deleted", "chat_id": update["chat_id"], "ids": server_ids[:100]}]
    return []


def build_payload(action, chat_id, observed_iso, message=None, ids=None):
    """The exact body of POST /internal/ingest/telegram-user (schemaVersion 1, api_live)."""
    body = {"schemaVersion": 1, "captureMethod": "api_live", "chat": {"id": chat_id, "type": "channel"}, "clientObservedAt": observed_iso}
    if action == "deleted":
        body["event"] = "delete"
        body["deletedMessageIds"] = list(ids)
    else:
        body["event"] = "message"
        body["messages"] = [message]
    return body
