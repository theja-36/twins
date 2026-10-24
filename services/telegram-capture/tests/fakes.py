import collections
import io
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from twins_capture.config import load_config  # noqa: E402
from twins_capture.ingest import Sink  # noqa: E402
from twins_capture.safelog import SafeLogger  # noqa: E402
from twins_capture.state import State  # noqa: E402
from twins_capture.tdlib import ensure_allowed, PINNED_TDLIB_COMMIT  # noqa: E402

CHAT = -1001000000001  # synthetic
OTHER_CHAT = -1002000000002
POISON = "ZZPOISONTEXTZZ BUY NIFTY 24500 CE 9876543210 +15550001111 sk-secret-token-abcdef"
API_HASH = "0123456789abcdef0123456789abcdef"
TOKEN = "T" * 40
DB_KEY = "ab" * 32


def make_env(session_dir, state_dir, **over):
    env = {
        "TWINS_TELEGRAM_API_ID": "12345",
        "TWINS_TELEGRAM_API_HASH": API_HASH,
        "TWINS_TELEGRAM_SESSION_DB_KEY": DB_KEY,
        "TWINS_TELEGRAM_ALLOWED_CHAT_IDS": str(CHAT),
        "TWINS_CAPTURE_INGEST_TOKEN": TOKEN,
        "TWINS_CAPTURE_INGEST_URL": "http://api:4000/internal/ingest/telegram-user",
        "TWINS_TELEGRAM_SESSION_DIR": session_dir,
        "TWINS_CAPTURE_STATE_DIR": state_dir,
    }
    env.update(over)
    return env


def tdmsg(chat, server_id, text, date=1_760_000_000, edit=0, ctype="messageText", entities=None):
    content = {"@type": ctype, ("text" if ctype == "messageText" else "caption"): {"text": text, "entities": entities or []}}
    return {"@type": "message", "id": server_id << 20, "chat_id": chat, "date": date, "edit_date": edit, "content": content}


class Clock(object):
    def __init__(self, now=1_760_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeTransport(object):
    """Scripted TDLib. Records every request; answers from `messages`, `chats`, `auth_script`; updates come from `inbox`."""

    def __init__(self, clock, ready=True, protected=False, member="chatMemberStatusMember", commit=PINNED_TDLIB_COMMIT, version="1.8.68"):
        self.clock, self.sent, self.executed, self.inbox = clock, [], [], collections.deque()
        self.messages, self.errors = {}, {}
        self.ready, self.protected, self.member, self.commit, self.version = ready, protected, member, commit, version
        self.auth_after_params = "authorizationStateReady" if ready else "authorizationStateWaitCode"
        self.client_ids = 0
        self.closing, self.close_polls, self.close_delay_polls, self.never_close = False, 0, 2, False
        self.closed_delivered = False

    def execute(self, request):
        ensure_allowed(request.get("@type"))
        self.executed.append(request)
        if request["@type"] == "getOption":
            value = self.version if request["name"] == "version" else self.commit
            return {"@type": "optionValueString", "value": value}
        return {"@type": "ok"}

    def create_client_id(self):
        self.client_ids += 1
        return self.client_ids

    def push_state(self, state):
        self.inbox.append({"@type": "updateAuthorizationState", "authorization_state": {"@type": state}})

    def send(self, client_id, request):
        ensure_allowed(request.get("@type"))
        self.sent.append(request)
        kind, extra = request["@type"], request.get("@extra")
        if kind in self.errors:
            code, text = self.errors[kind]
            self.inbox.appendleft({"@type": "error", "@extra": extra, "code": code, "message": text})
            return
        reply = {"@type": "ok"}
        if kind == "close":
            self.closing = True  # TDLib answers `ok` at once and only LATER reports authorizationStateClosed
            self.inbox.append({"@type": "updateAuthorizationState", "authorization_state": {"@type": "authorizationStateClosing"}})
        elif kind == "getOption":
            self.push_state("authorizationStateWaitTdlibParameters")
        elif kind == "setTdlibParameters":
            self.push_state(self.auth_after_params)
        elif kind == "checkAuthenticationCode":
            self.push_state("authorizationStateReady")
        elif kind == "getChat":
            reply = {"@type": "chat", "id": request["chat_id"], "title": "T", "type": {"@type": "chatTypeSupergroup", "supergroup_id": 1}, "has_protected_content": self.protected}
        elif kind == "getSupergroup":
            reply = {"@type": "supergroup", "id": request["supergroup_id"], "is_channel": True, "status": {"@type": self.member}}
        elif kind == "getMessage":
            found = self.messages.get((request["chat_id"], request["message_id"]))
            if found is None:
                self.inbox.appendleft({"@type": "error", "@extra": extra, "code": 404, "message": "Message not found"})
                return
            reply = found
        reply = dict(reply)
        reply["@extra"] = extra
        self.inbox.appendleft(reply)  # replies first, so a request never waits behind queued updates

    def receive(self, timeout):
        if self.inbox:
            update = self.inbox.popleft()
            if update.get("@type") == "updateAuthorizationState" and update["authorization_state"]["@type"] == "authorizationStateClosed":
                self.closed_delivered = True
            return update
        if self.closing and not self.never_close:
            self.close_polls += 1
            if self.close_polls > self.close_delay_polls:
                self.push_state("authorizationStateClosed")
                self.closing = False
                return self.receive(timeout)
        self.clock.sleep(timeout)
        return None


class RecordingPoster(object):
    def __init__(self, statuses=None):
        self.bodies, self.statuses = [], collections.deque(statuses or [])

    def post(self, payload):
        self.bodies.append(payload)
        status = self.statuses.popleft() if self.statuses else 202
        if isinstance(status, Exception):
            raise status
        return (status, None) if not isinstance(status, tuple) else status


class Env(object):
    """Everything a session test needs, in a temp directory."""

    def __init__(self, ready=True, statuses=None, **transport_kwargs):
        self.tmp = tempfile.TemporaryDirectory()
        base = self.tmp.name
        self.session_dir, self.state_dir = os.path.join(base, "tdlib-db"), os.path.join(base, "state")
        self.cfg = load_config(make_env(self.session_dir, self.state_dir))
        self.clock = Clock()
        self.stream = io.StringIO()
        self.log = SafeLogger(self.stream, clock=self.clock)
        self.transport = FakeTransport(self.clock, ready=ready, **transport_kwargs)
        self.poster = RecordingPoster(statuses)
        self.sink = Sink(self.poster, self.log, self.clock, rng=lambda: 0.0)
        self.state = State(self.state_dir, clock=self.clock)

    def logs(self):
        return [json.loads(line) for line in self.stream.getvalue().splitlines() if line]

    def close(self):
        self.tmp.cleanup()
