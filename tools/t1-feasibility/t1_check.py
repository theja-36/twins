#!/usr/bin/env python3
"""TWINS T1: local, read-only Telegram feasibility check. Metadata only.

Standard library only. Talks to Telegram solely through TDLib's JSON interface (the pinned, self-built libtdjson, loaded with ctypes).
Run it yourself, in your own Terminal, because it asks for your phone number, login code and (if set) 2FA password at
its own prompts. See README.md. Nothing is installed, stored or sent by this file beyond what is described here.

What it prints (the ONLY output): channel title/id, membership status, protected-content flag, and the latest message's
id/date/edit date/content-type NAME. Listen mode prints only event kinds and message ids.
What it never prints, stores or logs: message text or captions, sender names, other chats, phone numbers, login codes,
passwords, api_hash, tokens, raw TDLib responses. TDLib logging is switched off before the first request.
It only issues the request types in ALLOWED_REQUESTS. It never retries after an error, never logs in on its own, asks
for the login code and the password at most once each per run, and stops on any flood-wait.
"""
import argparse
import base64
import ctypes
import datetime
import getpass
import json
import os
import re
import shutil
import stat
import sys
import time

TOOL_VERSION = "1"
HOME_DIR_NAME = ".twins-t1"
DB_DIR_NAME = "tdlib-db"
MIN_LISTEN_SECONDS = 10
MAX_LISTEN_SECONDS = 900
MAX_LOAD_PAGES = 10
REQUEST_TIMEOUT = 60.0
LOGIN_TIMEOUT = 600.0

# The tool only runs against the pinned, self-built TDLib (docs/implementation/phase1/TDLIB_PINNED_BUILD.md): official
# repository https://github.com/tdlib/td.git, release commit "Update version to 1.8.68." The library states the commit it was
# built from (`commit_hash`); anything else is refused before a client is created.
MIN_TDLIB = (1, 8, 6)  # first version with the inline setTdlibParameters login API this tool uses
PINNED_TDLIB_COMMIT = "c15d3f5a5de6e3ba5839822c451152e5e18bb700"
PINNED_BUILD_DIR_NAME = ".twins-t1-build"
PINNED_LIBRARY_RELATIVE = os.path.join("install", "lib", "libtdjson.dylib")

# The exact set of TDLib request types this tool may send. A static test keeps this list and the source in sync.
ALLOWED_REQUESTS = frozenset(
    {
        "setLogVerbosityLevel",
        "setLogStream",
        "getOption",
        "setTdlibParameters",
        "setAuthenticationPhoneNumber",
        "checkAuthenticationCode",
        "checkAuthenticationPassword",
        "loadChats",
        "getChat",
        "getSupergroup",
        "getChatHistory",
        "logOut",
        "close",
    }
)
CHAT_LIST_MAIN = {"@type": "chatListMain"}
CHAT_LIST_ARCHIVE = {"@type": "chatListArchive"}
LOG_STREAM_EMPTY = {"@type": "logStreamEmpty"}


class T1Error(Exception):
    """A safe, short error. Messages never contain secrets or message content."""

    def __init__(self, message, code=None):
        Exception.__init__(self, message)
        self.code = code


class FloodWait(T1Error):
    pass


class NotLoggedIn(T1Error):
    pass


# ---------------------------------------------------------------------------------------------------- request guard
def ensure_allowed(request_type):
    if request_type not in ALLOWED_REQUESTS:
        raise T1Error("internal error: request type is not allowed")


def req(request_type, **fields):
    ensure_allowed(request_type)
    body = {"@type": request_type}
    body.update(fields)
    return body


# ---------------------------------------------------------------------------------------------------- reductions
_TYPE_NAME = re.compile(r"^[A-Za-z]{1,48}\Z")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f  ]")


def safe_type_name(value):
    return value if isinstance(value, str) and _TYPE_NAME.match(value) else "unknown"


def iso(ts):
    if isinstance(ts, bool) or not isinstance(ts, int) or ts <= 0:
        return None
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sanitize_title(value):
    if not isinstance(value, str):
        return ""
    text = _CONTROL.sub(" ", value).replace('"', "'")
    return " ".join(text.split())[:80]


def reduce_message(message):
    """Keep ONLY id, date, edit date and the content type NAME. Text, captions and senders are never read."""
    if not isinstance(message, dict):
        raise T1Error("unexpected message shape")
    message_id = message.get("id")
    if isinstance(message_id, bool) or not isinstance(message_id, int):
        raise T1Error("unexpected message shape")
    content = message.get("content")
    content_type = content.get("@type") if isinstance(content, dict) else None
    return {
        "id": message_id,
        "date": iso(message.get("date")),
        "edit_date": iso(message.get("edit_date")),
        "content_type": safe_type_name(content_type),
    }


def reduce_chat(chat):
    if not isinstance(chat, dict):
        raise T1Error("unexpected chat shape")
    chat_id = chat.get("id")
    if isinstance(chat_id, bool) or not isinstance(chat_id, int):
        raise T1Error("unexpected chat shape")
    chat_type = chat.get("type")
    return {
        "id": chat_id,
        "title": sanitize_title(chat.get("title")),
        "protected": chat.get("has_protected_content") is True,
        "type": safe_type_name(chat_type.get("@type") if isinstance(chat_type, dict) else None),
    }


def supergroup_id_of(chat):
    chat_type = chat.get("type") if isinstance(chat, dict) else None
    value = chat_type.get("supergroup_id") if isinstance(chat_type, dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


_MEMBERSHIP = {
    "chatMemberStatusMember": "member",
    "chatMemberStatusLeft": "left",
    "chatMemberStatusBanned": "banned",
    "chatMemberStatusRestricted": "restricted",
    "chatMemberStatusAdministrator": "administrator",
    "chatMemberStatusCreator": "creator",
}


def membership_name(holder):
    """Name of the current user's status. `holder` is a supergroup object: its `status` field is the status of the current user
    (td_api.tl: "Status of the current user in the supergroup or channel"). No member list is ever requested."""
    status = holder.get("status") if isinstance(holder, dict) else None
    status_type = status.get("@type") if isinstance(status, dict) else None
    return _MEMBERSHIP.get(status_type, "unknown")


def channel_kind(chat_summary, supergroup):
    if chat_summary["type"] == "chatTypeSupergroup" and isinstance(supergroup, dict):
        if supergroup.get("is_channel") is True:
            return "channel(broadcast)"
        return "supergroup"
    return chat_summary["type"]


def classify_update(update, target_chat_id):
    """Turn a TDLib update into zero or more content-free events: {kind, ids, content_type?}."""
    if not isinstance(update, dict):
        return []
    kind = update.get("@type")
    if kind == "updateNewMessage":
        message = update.get("message")
        if isinstance(message, dict) and message.get("chat_id") == target_chat_id:
            reduced = reduce_message(message)
            return [{"kind": "new", "ids": [reduced["id"]], "content_type": reduced["content_type"]}]
    elif kind == "updateMessageEdited":
        if update.get("chat_id") == target_chat_id and isinstance(update.get("message_id"), int):
            return [{"kind": "edited", "ids": [update["message_id"]]}]
    elif kind == "updateMessageContent":
        if update.get("chat_id") == target_chat_id and isinstance(update.get("message_id"), int):
            return [{"kind": "edited", "ids": [update["message_id"]]}]
    elif kind == "updateDeleteMessages":
        ids = update.get("message_ids")
        if (
            update.get("chat_id") == target_chat_id
            and update.get("is_permanent") is True
            and update.get("from_cache") is not True
            and isinstance(ids, list)
        ):
            return [{"kind": "deleted", "ids": [i for i in ids if isinstance(i, int)][:20]}]
    return []


# ---------------------------------------------------------------------------------------------------- arguments
def build_parser():
    parser = argparse.ArgumentParser(prog="t1_check.py", description="TWINS T1 read-only Telegram feasibility check (metadata only).")
    parser.add_argument("--mode", choices=("check", "listen", "logout"), default="check")
    parser.add_argument("--seconds", type=int, default=None, help="listen mode only: %d-%d" % (MIN_LISTEN_SECONDS, MAX_LISTEN_SECONDS))
    return parser


def parse_args(argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.mode == "listen":
        if args.seconds is None:
            args.seconds = 600
        if args.seconds < MIN_LISTEN_SECONDS or args.seconds > MAX_LISTEN_SECONDS:
            parser.error("--seconds must be between %d and %d" % (MIN_LISTEN_SECONDS, MAX_LISTEN_SECONDS))
    elif args.seconds is not None:
        parser.error("--seconds is only valid with --mode listen")
    return args


# ---------------------------------------------------------------------------------------------------- inputs
_API_HASH = re.compile(r"^[0-9a-f]{32}\Z")
_DB_KEY = re.compile(r"^[0-9a-f]{64}\Z")
_CHANNEL_ID = re.compile(r"^-100[0-9]{9,13}\Z")


def home_dir():
    return os.path.join(os.path.expanduser("~"), HOME_DIR_NAME)


def pinned_library_path():
    return os.path.join(os.path.dirname(home_dir()), PINNED_BUILD_DIR_NAME, PINNED_LIBRARY_RELATIVE)


def parse_version(text):
    match = re.match(r"^([0-9]+)\.([0-9]+)\.([0-9]+)\Z", text) if isinstance(text, str) else None
    return tuple(int(part) for part in match.groups()) if match else None


def verify_library(transport):
    """Refuse any TDLib that is too old or is not the pinned commit, BEFORE a client exists (the option calls are synchronous)."""
    values = {}
    for name in ("version", "commit_hash"):
        reply = transport.execute(req("getOption", name=name))
        value = reply.get("value") if isinstance(reply, dict) and reply.get("@type") == "optionValueString" else None
        values[name] = value if isinstance(value, str) else ""
    version = parse_version(values["version"])
    shown = re.sub(r"[^0-9A-Za-z._-]", "", values["version"])[:20] or "unknown"
    if version is None or version < MIN_TDLIB:
        raise T1Error("this TDLib (%s) is too old for the tool; use the pinned build (docs/implementation/phase1/TDLIB_PINNED_BUILD.md)" % shown)
    if values["commit_hash"] != PINNED_TDLIB_COMMIT:
        raise T1Error("this TDLib build is not the pinned commit; use the pinned build (docs/implementation/phase1/TDLIB_PINNED_BUILD.md)")
    return shown, values["commit_hash"]


def _check_private(path, expect_dir):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        raise T1Error("%s must not be a symbolic link" % os.path.basename(path))
    if expect_dir != stat.S_ISDIR(info.st_mode):
        raise T1Error("%s has the wrong type" % os.path.basename(path))
    if info.st_uid != os.getuid():
        raise T1Error("%s is not owned by you" % os.path.basename(path))
    if info.st_mode & 0o077:
        raise T1Error("%s must not be accessible by others (use mode %s)" % (os.path.basename(path), "700" if expect_dir else "600"))


def _read_secret_file(home, name):
    path = os.path.join(home, name)
    if not os.path.exists(path):
        raise T1Error("missing input file: %s" % name)
    _check_private(path, False)
    with open(path, "r") as handle:
        return handle.read().strip()


def load_inputs(home):
    """Read api_id, api_hash, channel id and the database key from the private directory. Values never appear in errors."""
    if not os.path.isdir(home):
        raise T1Error("private directory %s does not exist" % HOME_DIR_NAME)
    _check_private(home, True)
    api_id_text = _read_secret_file(home, "api_id")
    api_hash = _read_secret_file(home, "api_hash")
    channel_text = _read_secret_file(home, "channel_id")
    key_hex = _read_secret_file(home, "db.key")
    if not api_id_text.isdigit() or not (1 <= len(api_id_text) <= 12):
        raise T1Error("api_id file has an unexpected format")
    if not _API_HASH.match(api_hash):
        raise T1Error("api_hash file has an unexpected format")
    if not _CHANNEL_ID.match(channel_text):
        raise T1Error("channel_id file has an unexpected format (expected the -100... form)")
    if not _DB_KEY.match(key_hex):
        raise T1Error("db.key file has an unexpected format")
    return {
        "api_id": int(api_id_text),
        "api_hash": api_hash,
        "channel_id": int(channel_text),
        "db_key_b64": base64.b64encode(bytes.fromhex(key_hex)).decode("ascii"),
    }


def delete_session_dir(home):
    """Delete ONLY <home>/tdlib-db, after checking the resolved path stays inside the private directory."""
    target = os.path.join(home, DB_DIR_NAME)
    if not os.path.lexists(target):
        return False
    real_home = os.path.realpath(home)
    real_target = os.path.realpath(target)
    if os.path.dirname(real_target) != real_home or os.path.basename(real_target) != DB_DIR_NAME:
        raise T1Error("refusing to delete: unexpected session path")
    shutil.rmtree(real_target)
    return True


# ---------------------------------------------------------------------------------------------------- native transport
class TdTransport(object):
    """The only code that touches the native TDLib library."""

    def __init__(self, library_path=None):
        candidates = []
        if library_path:
            candidates.append(library_path)
        override = os.environ.get("TWINS_T1_TDJSON")
        if override:
            candidates.append(override)
        candidates.append(pinned_library_path())  # the pinned build; there is deliberately no fallback to other TDLib copies
        lib = None
        for candidate in candidates:
            if os.path.isfile(candidate):
                lib = ctypes.CDLL(candidate)
                break
        if lib is None:
            raise T1Error("pinned TDLib library not found (build it first: docs/implementation/phase1/TDLIB_PINNED_BUILD.md; or point TWINS_T1_TDJSON at it)")
        try:
            lib.td_create_client_id.restype = ctypes.c_int
            lib.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
            lib.td_send.restype = None
            lib.td_receive.argtypes = [ctypes.c_double]
            lib.td_receive.restype = ctypes.c_char_p
            lib.td_execute.argtypes = [ctypes.c_char_p]
            lib.td_execute.restype = ctypes.c_char_p
        except AttributeError:
            raise T1Error("this TDLib version is too old (td_create_client_id is missing)")
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


# ---------------------------------------------------------------------------------------------------- io
class TerminalIO(object):
    def out(self, line):
        sys.stdout.write(line + "\n")
        sys.stdout.flush()

    def err(self, line):
        sys.stderr.write(line + "\n")
        sys.stderr.flush()

    def prompt_phone(self):
        return input("Phone number in international format (e.g. +91...): ").strip()

    def prompt_code(self):
        return getpass.getpass("Login code shown in your Telegram app (input hidden): ").strip()

    def prompt_password(self):
        return getpass.getpass("Two-step verification password (input hidden): ")

    def sleep(self, seconds):
        time.sleep(seconds)

    def clock(self):
        return time.monotonic()


# ---------------------------------------------------------------------------------------------------- session
_UNSUPPORTED_AUTH = (
    "authorizationStateWaitRegistration",
    "authorizationStateWaitOtherDeviceConfirmation",
    "authorizationStateWaitEmailAddress",
    "authorizationStateWaitEmailCode",
    "authorizationStateWaitPremiumPurchase",
)


class Session(object):
    def __init__(self, transport, io, inputs, home):
        self.transport = transport
        self.io = io
        self.inputs = inputs
        self.home = home
        self.client_id = transport.create_client_id()
        self.auth_state = None
        self.tdlib_version = "unknown"
        self.tdlib_commit = "unknown"
        self._extra = 0
        self._params_sent = False
        self._attempts = {"phone": 0, "code": 0, "password": 0}
        self._pending_events = []

    # -- plumbing
    def _handle_update(self, message):
        if message.get("@type") == "updateAuthorizationState":
            state = message.get("authorization_state")
            if isinstance(state, dict):
                self.auth_state = state.get("@type")
        else:
            self._pending_events.extend(classify_update(message, self.inputs["channel_id"]))

    def request(self, request_type, timeout=REQUEST_TIMEOUT, **fields):
        body = req(request_type, **fields)
        self._extra += 1
        extra = "t1-%d" % self._extra
        body["@extra"] = extra
        self.transport.send(self.client_id, body)
        deadline = self.io.clock() + timeout
        while self.io.clock() < deadline:
            message = self.transport.receive(1.0)
            if message is None:
                continue
            if message.get("@extra") == extra:
                if message.get("@type") == "error":
                    self._raise_error(message)
                return message
            if "@extra" not in message:
                self._handle_update(message)
        raise T1Error("timed out waiting for Telegram")

    @staticmethod
    def _raise_error(message):
        code = message.get("code") if isinstance(message.get("code"), int) else None
        text = message.get("message") if isinstance(message.get("message"), str) else ""
        wait = re.search(r"retry after ([0-9]+)", text, re.IGNORECASE)
        if code == 429 or wait or "FLOOD_WAIT" in text.upper():
            seconds = wait.group(1) if wait else "unknown"
            raise FloodWait("Telegram asked to wait (%s s). Stopping; do not run again before then." % seconds, code)
        safe = re.sub(r"[^A-Za-z0-9_ ]", "", text)[:60]
        raise T1Error("Telegram returned an error (code %s: %s)" % (code, safe), code)

    def pump(self, timeout):
        message = self.transport.receive(timeout)
        if message is not None and "@extra" not in message:
            self._handle_update(message)

    def take_events(self):
        events, self._pending_events = self._pending_events, []
        return events

    # -- login state machine
    def _tdlib_parameters(self):
        return dict(
            use_test_dc=False,
            database_directory=os.path.join(self.home, DB_DIR_NAME),
            database_encryption_key=self.inputs["db_key_b64"],
            use_file_database=False,
            use_chat_info_database=True,
            use_message_database=False,
            use_secret_chats=False,
            api_id=self.inputs["api_id"],
            api_hash=self.inputs["api_hash"],
            system_language_code="en",
            device_model="TWINS T1 feasibility",
            system_version="",
            application_version="t1",
        )

    def ensure_ready(self, allow_login):
        self.request("getOption", name="version")  # starts the authorization state machine; the verified values are kept as they are
        deadline = self.io.clock() + LOGIN_TIMEOUT
        while self.io.clock() < deadline:
            state = self.auth_state
            if state is None:
                self.pump(1.0)
            elif state == "authorizationStateWaitTdlibParameters":
                if self._params_sent:
                    raise T1Error("TDLib asked for its parameters twice; stopping")
                self._params_sent = True
                self.request("setTdlibParameters", **self._tdlib_parameters())
                self.pump(1.0)
            elif state == "authorizationStateWaitPhoneNumber":
                if not allow_login:
                    raise NotLoggedIn("no active session found (run --mode check first)")
                if self._attempts["phone"] >= 1:
                    raise T1Error("the phone number was not accepted; stopping (run again to restart the login)")
                self._attempts["phone"] += 1
                phone = self.io.prompt_phone()
                self.request("setAuthenticationPhoneNumber", phone_number=phone)
                phone = None
                self.pump(1.0)
            elif state == "authorizationStateWaitCode":
                if not allow_login:
                    raise NotLoggedIn("no active session found (run --mode check first)")
                if self._attempts["code"] >= 1:
                    raise T1Error("the login code was not accepted; stopping (run again to restart the login)")
                self._attempts["code"] += 1
                code = self.io.prompt_code()
                self.request("checkAuthenticationCode", code=code)
                code = None
                self.pump(1.0)
            elif state == "authorizationStateWaitPassword":
                if not allow_login:
                    raise NotLoggedIn("no active session found (run --mode check first)")
                if self._attempts["password"] >= 1:
                    raise T1Error("the password was not accepted; stopping (run again to restart the login)")
                self._attempts["password"] += 1
                password = self.io.prompt_password()
                self.request("checkAuthenticationPassword", password=password)
                password = None
                self.pump(1.0)
            elif state == "authorizationStateReady":
                return
            elif state in _UNSUPPORTED_AUTH:
                raise T1Error("unsupported login step (%s); stopping" % safe_type_name(state))
            elif state in ("authorizationStateWaitEncryptionKey",):
                raise T1Error("this TDLib version is too old for this tool; stopping")
            else:
                raise T1Error("session is closing or closed; stopping")
        raise T1Error("login timed out")

    # -- reads
    def find_chat(self, channel_id):
        """Resolve the configured channel in the account's chat list. Paged loading, bounded, never a retry after an error."""
        for chat_list in (CHAT_LIST_MAIN, CHAT_LIST_ARCHIVE):
            for _page in range(MAX_LOAD_PAGES):
                try:
                    return self.request("getChat", chat_id=channel_id)
                except FloodWait:
                    raise
                except T1Error as error:
                    if error.code not in (400, 404):
                        raise
                try:
                    self.request("loadChats", chat_list=chat_list, limit=100)
                except FloodWait:
                    raise
                except T1Error as error:
                    if error.code == 404:
                        break
                    raise
                self.io.sleep(1.0)
        try:
            return self.request("getChat", chat_id=channel_id)
        except FloodWait:
            raise
        except T1Error:
            raise T1Error("the channel was not found in this account's chats (is the account a member?)")

    def gather(self):
        channel_id = self.inputs["channel_id"]
        chat = self.find_chat(channel_id)
        summary = reduce_chat(chat)
        supergroup_id = supergroup_id_of(chat)
        if supergroup_id is None:
            raise T1Error("the configured chat is not a channel or supergroup; this tool only checks those")
        # Membership: chat -> type.supergroup_id -> getSupergroup -> status. `status` is the CURRENT user's own status, read from
        # the supergroup object. Member lists, administrator lists and per-user member lookups are never requested (for broadcast
        # channels Telegram refuses them to non-administrators anyway: "Member list is inaccessible").
        supergroup = self.request("getSupergroup", supergroup_id=supergroup_id)
        if not isinstance(supergroup, dict) or supergroup.get("id") != supergroup_id:
            raise T1Error("unexpected supergroup response; stopping")
        membership = membership_name(supergroup)
        if membership == "unknown":
            raise T1Error("could not determine the membership status of this chat; stopping (nothing is assumed)")
        history = self.request("getChatHistory", chat_id=channel_id, from_message_id=0, offset=0, limit=1, only_local=False)
        messages = history.get("messages") if isinstance(history, dict) else None
        latest = reduce_message(messages[0]) if isinstance(messages, list) and messages else None
        return {
            "chat": summary,
            "kind": channel_kind(summary, supergroup),
            "membership": membership,
            "latest": latest,
        }

    def close(self):
        try:
            self.request("close", timeout=15.0)
        except T1Error:
            pass
        deadline = self.io.clock() + 10.0
        while self.io.clock() < deadline and self.auth_state != "authorizationStateClosed":
            self.pump(0.5)


# ---------------------------------------------------------------------------------------------------- modes
def format_metadata(inputs, session, data):
    lines = []
    lines.append("tool=t1 version=%s tdlib=%s commit=%s" % (TOOL_VERSION, session.tdlib_version, session.tdlib_commit[:10]))
    lines.append("authorization=ready")
    chat = data["chat"]
    lines.append('channel_id=%d title="%s" type=%s' % (inputs["channel_id"], chat["title"], data["kind"]))
    lines.append("membership=%s" % data["membership"])
    lines.append("protected_content=%s" % ("true" if chat["protected"] else "false"))
    latest = data["latest"]
    if latest is None:
        lines.append("latest_message: none_returned (run again if the channel is not empty)")
    else:
        lines.append(
            "latest_message: id=%d date=%s edit_date=%s content_type=%s"
            % (latest["id"], latest["date"] or "none", latest["edit_date"] or "none", latest["content_type"])
        )
    return lines


def run_check(session, io):
    session.ensure_ready(allow_login=True)
    data = session.gather()
    for line in format_metadata(session.inputs, session, data):
        io.out(line)
    io.out("events_observable: new=unknown edited=unknown deleted=unknown  (use --mode listen to observe events)")
    return 0


def run_listen(session, io, seconds):
    session.ensure_ready(allow_login=False)
    session.find_chat(session.inputs["channel_id"])
    io.out("listening for %d seconds (event kinds and message ids only)" % seconds)
    seen = {"new": 0, "edited": 0, "deleted": 0}
    start = io.clock()
    while io.clock() - start < seconds:
        session.pump(1.0)
        for event in session.take_events():
            seen[event["kind"]] += 1
            extra = (" content_type=%s" % event["content_type"]) if "content_type" in event else ""
            io.out("[+%ds] %s ids=%s%s" % (int(io.clock() - start), event["kind"], ",".join(str(i) for i in event["ids"]), extra))
    flags = " ".join("%s=%s" % (kind, "seen" if seen[kind] else "not_seen") for kind in ("new", "edited", "deleted"))
    io.out("events_observable: %s  (not_seen only means none occurred in this window)" % flags)
    return 0


def run_logout(session, io, home):
    ended_remotely = False
    try:
        session.ensure_ready(allow_login=False)
        session.request("logOut", timeout=30.0)
        deadline = io.clock() + 30.0
        while io.clock() < deadline and session.auth_state != "authorizationStateClosed":
            session.pump(0.5)
        ended_remotely = True
    except NotLoggedIn:
        io.out("no active session on this machine")
    removed = delete_session_dir(home)
    io.out("server_side_logout=%s local_session_deleted=%s" % ("done" if ended_remotely else "not_needed", "yes" if removed else "nothing_to_delete"))
    io.out("now confirm in the Telegram app (Settings > Devices) that the session named 'TWINS T1 feasibility' is gone; terminate it there if it is still listed")
    return 0


def run(args, transport, io, home):
    """Entry point used by main() and by the tests (with a scripted fake transport)."""
    try:
        if args.mode == "logout" and not os.path.isdir(os.path.join(home, DB_DIR_NAME)):
            io.out("no local session found; nothing to log out locally. Check Settings > Devices in the Telegram app.")
            return 0
        inputs = load_inputs(home)
        transport.execute(req("setLogVerbosityLevel", new_verbosity_level=0))
        transport.execute(req("setLogStream", log_stream=LOG_STREAM_EMPTY))
        tdlib_version, tdlib_commit = verify_library(transport)
        session = Session(transport, io, inputs, home)
        session.tdlib_version, session.tdlib_commit = tdlib_version, tdlib_commit
        try:
            if args.mode == "check":
                return run_check(session, io)
            if args.mode == "listen":
                return run_listen(session, io, args.seconds)
            return run_logout(session, io, home)
        finally:
            if args.mode != "logout":
                session.close()  # always close the TDLib client so the local database is left consistent
    except FloodWait as error:
        io.err("flood-wait: %s" % error)
        return 3
    except NotLoggedIn as error:
        io.err("error: %s" % error)
        return 2
    except T1Error as error:
        io.err("error: %s" % error)
        return 2


def main(argv=None):
    os.umask(0o077)
    args = parse_args(sys.argv[1:] if argv is None else argv)
    io = TerminalIO()
    if args.mode == "check" and not (sys.stdin.isatty() and sys.stderr.isatty()):
        io.err("error: run this in your own interactive Terminal (the login prompts need a keyboard)")
        return 2
    try:
        transport = TdTransport()
    except T1Error as error:
        io.err("error: %s" % error)
        return 2
    return run(args, transport, io, home_dir())


if __name__ == "__main__":
    sys.exit(main())
