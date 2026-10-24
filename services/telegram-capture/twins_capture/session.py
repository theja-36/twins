"""One TDLib client session: the authorization state machine, the approved-channel check and the update loop.
Never logs in on its own (`run` has no prompts), never retries after a Telegram error, stops on any flood-wait."""
import collections
import datetime
import os
import re
import stat

from .ingest import IngestFatal  # noqa: F401  (re-exported for the supervisor)
from .mapping import build_payload, classify_update, map_message
from .tdlib import CaptureError, FloodWait, req

REQUEST_TIMEOUT = 60.0
LOGIN_TIMEOUT = 600.0
CLOSE_REQUEST_TIMEOUT = 10.0
CLOSE_WAIT_TIMEOUT = 15.0  # request + wait stay under the container's 30 s stop grace period
STALE_CONNECTION_SECONDS = 600
MAX_LOAD_PAGES = 10
CHAT_LIST_MAIN = {"@type": "chatListMain"}
CHAT_LIST_ARCHIVE = {"@type": "chatListArchive"}
_UNSUPPORTED_AUTH = (
    "authorizationStateWaitRegistration",
    "authorizationStateWaitOtherDeviceConfirmation",
    "authorizationStateWaitEmailAddress",
    "authorizationStateWaitEmailCode",
    "authorizationStateWaitPremiumPurchase",
)
_MEMBER_OK = ("chatMemberStatusMember", "chatMemberStatusAdministrator", "chatMemberStatusCreator")


class AuthFailure(CaptureError):
    """The session is not (or no longer) logged in. The service stops and alerts; it NEVER logs in again by itself."""

    def __init__(self, reason):
        CaptureError.__init__(self, reason)
        self.reason = reason


class ChatUnavailable(CaptureError):
    def __init__(self, reason):
        CaptureError.__init__(self, reason)
        self.reason = reason


class Recoverable(CaptureError):
    """A transient problem (timeout, stale connection): the supervisor restarts the session with capped backoff."""


def _safe_name(value):
    return value if isinstance(value, str) and re.match(r"^[A-Za-z]{1,48}\Z", value) else "unknown"


class Session(object):
    def __init__(self, transport, cfg, sink, log, state, clock, sleep):
        self.transport, self.cfg, self.sink, self.log, self.state, self.clock, self.sleep = transport, cfg, sink, log, state, clock, sleep
        self.client_id = transport.create_client_id()
        self.auth_state = None
        self.connection_state = None
        self._not_ready_since = clock()
        self._extra = 0
        self._params_sent = False
        self._attempts = {"phone": 0, "code": 0, "password": 0}
        self._actions = collections.deque()
        self._seen_ready = False

    # ------------------------------------------------------------------ plumbing
    def _dispatch(self, update):
        kind = update.get("@type")
        if kind == "updateAuthorizationState":
            state = update.get("authorization_state")
            if isinstance(state, dict):
                self.auth_state = state.get("@type")
        elif kind == "updateConnectionState":
            state = update.get("state")
            self.connection_state = state.get("@type") if isinstance(state, dict) else None
            if self.connection_state == "connectionStateReady":
                self._not_ready_since = None
            elif self._not_ready_since is None:
                self._not_ready_since = self.clock()
            self.log.log("capture.connection", tdlib_state=_safe_name(self.connection_state))
        else:
            self._actions.extend(classify_update(update, self.cfg.chat_ids))

    def request(self, request_type, timeout=REQUEST_TIMEOUT, **fields):
        body = req(self.cfg.chat_ids, request_type, **fields)
        self._extra += 1
        extra = "cap-%d" % self._extra
        body["@extra"] = extra
        self.transport.send(self.client_id, body)
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            message = self.transport.receive(1.0)
            if message is None:
                continue
            if message.get("@extra") == extra:
                if message.get("@type") == "error":
                    self._raise_error(message)
                return message
            if "@extra" not in message:
                self._dispatch(message)
        raise Recoverable("timed out waiting for Telegram")

    @staticmethod
    def _raise_error(message):
        code = message.get("code") if isinstance(message.get("code"), int) else None
        text = message.get("message") if isinstance(message.get("message"), str) else ""
        wait = re.search(r"retry after ([0-9]+)", text, re.IGNORECASE)
        if code == 429 or wait or "FLOOD_WAIT" in text.upper():
            raise FloodWait(int(wait.group(1)) if wait else 3600, code or 429)
        if code == 401:
            raise AuthFailure("session_unauthorized")
        raise CaptureError("Telegram returned an error", code)

    def pump(self, timeout):
        message = self.transport.receive(timeout)
        if message is not None and "@extra" not in message:
            self._dispatch(message)

    # ------------------------------------------------------------------ authorization
    def _tdlib_parameters(self):
        return dict(
            use_test_dc=False,
            database_directory=self.cfg.session_dir,
            database_encryption_key=self.cfg.db_key_b64,
            use_file_database=False,
            use_chat_info_database=True,
            use_message_database=False,
            use_secret_chats=False,
            api_id=self.cfg.api_id,
            api_hash=self.cfg.api_hash,
            system_language_code="en",
            device_model="TWINS capture",
            system_version="",
            application_version="capture-1",
        )

    def ensure_ready(self, io=None):
        """`io` is None for the service (no login possible: a login step means AuthFailure) and a prompt object for the owner's `login` mode."""
        self.request("getOption", name="version")  # starts the authorization state machine
        deadline = self.clock() + LOGIN_TIMEOUT
        while self.clock() < deadline:
            state = self.auth_state
            if state is None:
                self.pump(1.0)
            elif state == "authorizationStateWaitTdlibParameters":
                if self._params_sent:
                    raise AuthFailure("tdlib_parameters_asked_twice")
                self._params_sent = True
                self.request("setTdlibParameters", **self._tdlib_parameters())
                self.pump(1.0)
            elif state in ("authorizationStateWaitPhoneNumber", "authorizationStateWaitCode", "authorizationStateWaitPassword"):
                if io is None:
                    raise AuthFailure("login_required")  # waiting code/password: never answered automatically
                self._login_step(io, state)
            elif state == "authorizationStateReady":
                self._seen_ready = True
                return
            elif state in _UNSUPPORTED_AUTH:
                raise AuthFailure("unsupported_login_step")
            else:
                raise AuthFailure("session_closing")
        raise AuthFailure("login_timeout")

    def _login_step(self, io, state):
        name, request_type, prompt, field = {
            "authorizationStateWaitPhoneNumber": ("phone", "setAuthenticationPhoneNumber", io.prompt_phone, "phone_number"),
            "authorizationStateWaitCode": ("code", "checkAuthenticationCode", io.prompt_code, "code"),
            "authorizationStateWaitPassword": ("password", "checkAuthenticationPassword", io.prompt_password, "password"),
        }[state]
        if self._attempts[name] >= 1:
            raise AuthFailure("login_%s_not_accepted" % name)  # one attempt each per run; the owner restarts the login
        self._attempts[name] += 1
        value = prompt()
        self.request(request_type, **{field: value})
        value = None
        self.pump(1.0)

    # ------------------------------------------------------------------ the approved channels
    def _find_chat(self, chat_id):
        for chat_list in (CHAT_LIST_MAIN, CHAT_LIST_ARCHIVE):
            for _page in range(MAX_LOAD_PAGES):
                try:
                    return self.request("getChat", chat_id=chat_id)
                except FloodWait:
                    raise
                except CaptureError as error:
                    if error.code not in (400, 404):
                        raise
                try:
                    self.request("loadChats", chat_list=chat_list, limit=100)
                except FloodWait:
                    raise
                except CaptureError as error:
                    if error.code == 404:
                        break
                    raise
                self.sleep(1.0)
        try:
            return self.request("getChat", chat_id=chat_id)
        except FloodWait:
            raise
        except CaptureError:
            raise ChatUnavailable("chat_not_found")

    def resolve_chats(self):
        for chat_id in sorted(self.cfg.chat_ids):
            chat = self._find_chat(chat_id)
            chat_type = chat.get("type") if isinstance(chat.get("type"), dict) else {}
            supergroup_id = chat_type.get("supergroup_id")
            if chat_type.get("@type") != "chatTypeSupergroup" or not isinstance(supergroup_id, int):
                raise ChatUnavailable("not_a_channel")
            supergroup = self.request("getSupergroup", supergroup_id=supergroup_id)  # membership = the current user's OWN status; no member list
            if not isinstance(supergroup, dict) or supergroup.get("is_channel") is not True:
                raise ChatUnavailable("not_a_broadcast_channel")
            status = supergroup.get("status") if isinstance(supergroup.get("status"), dict) else {}
            if status.get("@type") not in _MEMBER_OK:
                raise ChatUnavailable("not_a_member")
            protected = chat.get("has_protected_content") is True
            previous = self.state.protected_content()
            if previous is not None and previous != protected:
                self.log.log("capture.protected_content_changed", level="warn", chat_id=chat_id, state="true" if protected else "false")
            self.state.set_protected_content(protected)
            if protected:
                raise ChatUnavailable("protected_content")  # paused: the owner of the channel forbids saving content

    # ------------------------------------------------------------------ the update loop
    def _iso_now(self):
        return datetime.datetime.fromtimestamp(self.clock(), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _handle_action(self, action):
        chat_id = action["chat_id"]
        observed = self._iso_now()
        if action["action"] == "new":
            payload_message, reason = map_message(action["message"])
            kind = "message"
        elif action["action"] == "edited":
            try:
                fetched = self.request("getMessage", chat_id=chat_id, message_id=action["tdlib_message_id"])
            except FloodWait:
                raise
            except CaptureError as error:
                if error.code in (400, 404):
                    self.log.log("capture.skipped", level="warn", reason="message_gone", chat_id=chat_id)
                    return
                raise
            payload_message, reason = map_message(fetched)
            if payload_message is not None and "editDate" not in payload_message:
                payload_message, reason = None, "no_edit_date"
            kind = "edited"
        else:
            self.sink.submit(build_payload("deleted", chat_id, observed, ids=action["ids"]), "deleted")
            return
        if payload_message is None:
            self.log.log("capture.skipped", reason=reason, chat_id=chat_id)
            return
        self.sink.submit(build_payload("message", chat_id, observed, message=payload_message), kind)

    def run(self, should_stop):
        while not should_stop():
            self.pump(1.0)
            while self._actions:
                self._handle_action(self._actions.popleft())
            self.sink.pump()  # raises IngestFatal when the endpoint refuses us
            if self.auth_state != "authorizationStateReady":
                raise AuthFailure("session_ended")  # revoked, logged out or closing: stop and alert; never log in again
            if self._not_ready_since is not None and self.clock() - self._not_ready_since > STALE_CONNECTION_SECONDS:
                raise Recoverable("connection stale")

    def close(self):
        """Graceful TDLib shutdown. `close` is only the START of closing: TDLib answers `ok` at once, then flushes its database and stops its
        threads and finally announces authorizationStateClosed. The process must not exit before that, or TDLib's threads are torn down
        mid-shutdown (an intermittent SIGABRT, exit code 134, was observed). So: ask, then keep receiving until Closed (bounded)."""
        if self.auth_state == "authorizationStateClosed":
            return True
        try:
            self.request("close", timeout=CLOSE_REQUEST_TIMEOUT)
        except CaptureError:
            pass
        deadline = self.clock() + CLOSE_WAIT_TIMEOUT
        while self.auth_state != "authorizationStateClosed" and self.clock() < deadline:
            self.pump(1.0)
        if self.auth_state == "authorizationStateClosed":
            self.log.log("capture.closed", tdlib_state="authorizationStateClosed")
            return True
        self.log.log("capture.close_timeout", level="warn", tdlib_state=_safe_name(self.auth_state))
        return False


def check_session_dir(path):
    """The TDLib database lives in a private (0700) directory that is not a symbolic link. It is created if missing."""
    os.makedirs(path, mode=0o700, exist_ok=True)
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise CaptureError("session directory must be a private (0700) directory owned by this user, not a link")
