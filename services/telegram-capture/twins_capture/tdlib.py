"""The only code that touches the native TDLib library, behind an EXACT request allowlist (enforced at run time AND by a static test).
There is no request that sends, forwards, joins, leaves, deletes, marks as read or changes anything on Telegram's side."""
import ctypes
import json
import os
import re

PINNED_TDLIB_COMMIT = "c15d3f5a5de6e3ba5839822c451152e5e18bb700"  # docs/implementation/phase1/TDLIB_PINNED_BUILD.md
MIN_TDLIB = (1, 8, 6)

ALLOWED_REQUESTS = frozenset(
    {
        "setLogVerbosityLevel",
        "setLogStream",
        "getOption",
        "setTdlibParameters",
        "setAuthenticationPhoneNumber",  # login mode only (owner at the keyboard); never reachable from `run`
        "checkAuthenticationCode",       # login mode only
        "checkAuthenticationPassword",   # login mode only
        "loadChats",
        "getChat",
        "getSupergroup",
        "getMessage",                    # read one message of an approved chat (to read the new content of an edit)
        "getChatHistory",                # history pilot only: read-only, hard-limited below, used solely by history.py
        "logOut",
        "close",
    }
)
LOG_STREAM_EMPTY = {"@type": "logStreamEmpty"}
CHAT_SCOPED_REQUESTS = frozenset({"getChat", "getMessage", "getChatHistory"})
HISTORY_PAGE_LIMIT = 50  # hard cap per getChatHistory request, enforced in req() so no caller can widen it


class CaptureError(Exception):
    """A safe, short error. Messages never contain secrets or message content."""

    def __init__(self, message, code=None):
        Exception.__init__(self, message)
        self.code = code


class FloodWait(CaptureError):
    def __init__(self, seconds, code=429):
        CaptureError.__init__(self, "Telegram asked to wait", code)
        self.seconds = seconds


def ensure_allowed(request_type):
    if request_type not in ALLOWED_REQUESTS:
        raise CaptureError("internal error: request type is not allowed")


def req(allowed_chats, request_type, **fields):
    """Builds a request. Any request that names a chat may name ONLY an approved chat (second allowlist, same discipline)."""
    ensure_allowed(request_type)
    if request_type in CHAT_SCOPED_REQUESTS and "chat_id" not in fields:
        raise CaptureError("internal error: a chat-scoped request must name its chat")  # an omitted chat_id must not skip the approved-chat check
    if "chat_id" in fields and fields["chat_id"] not in allowed_chats:
        raise CaptureError("internal error: chat is not approved")
    if request_type == "getChatHistory":
        limit, offset, only_local, from_id = fields.get("limit"), fields.get("offset"), fields.get("only_local"), fields.get("from_message_id")
        if not all(isinstance(v, int) and not isinstance(v, bool) for v in (limit, offset, from_id)) or not 1 <= limit <= HISTORY_PAGE_LIMIT or offset != 0 or from_id < 0 or only_local is not False:
            raise CaptureError("internal error: getChatHistory parameters are outside the hard limits")
    body = {"@type": request_type}
    body.update(fields)
    return body


def parse_version(text):
    match = re.match(r"^([0-9]+)\.([0-9]+)\.([0-9]+)\Z", text) if isinstance(text, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def verify_library(transport):
    """Refuse any TDLib that is too old or is not the pinned commit, BEFORE a client exists (the option calls are synchronous)."""
    values = {}
    for name in ("version", "commit_hash"):
        reply = transport.execute({"@type": "getOption", "name": name})
        value = reply.get("value") if isinstance(reply, dict) and reply.get("@type") == "optionValueString" else None
        values[name] = value if isinstance(value, str) else ""
    version = parse_version(values["version"])
    if version is None or version < MIN_TDLIB:
        raise CaptureError("TDLib is too old; use the pinned build")
    if values["commit_hash"] != PINNED_TDLIB_COMMIT:
        raise CaptureError("TDLib is not the pinned commit; use the pinned build")
    return values["version"], values["commit_hash"]


class TdTransport(object):
    def __init__(self, library_path):
        if not os.path.isfile(library_path):
            raise CaptureError("pinned TDLib library not found")  # deliberately no fallback to any other copy
        lib = ctypes.CDLL(library_path)
        try:
            lib.td_create_client_id.restype = ctypes.c_int
            lib.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
            lib.td_send.restype = None
            lib.td_receive.argtypes = [ctypes.c_double]
            lib.td_receive.restype = ctypes.c_char_p
            lib.td_execute.argtypes = [ctypes.c_char_p]
            lib.td_execute.restype = ctypes.c_char_p
        except AttributeError:
            raise CaptureError("this TDLib version is too old (td_create_client_id is missing)")
        self._lib = lib

    def execute(self, request):
        ensure_allowed(request.get("@type"))
        raw = self._lib.td_execute(json.dumps(request).encode("utf-8"))
        return json.loads(raw.decode("utf-8")) if raw else None

    def create_client_id(self):
        return self._lib.td_create_client_id()

    def send(self, client_id, request):
        ensure_allowed(request.get("@type"))
        self._lib.td_send(client_id, json.dumps(request).encode("utf-8"))

    def receive(self, timeout):
        raw = self._lib.td_receive(timeout)
        return json.loads(raw.decode("utf-8")) if raw else None
