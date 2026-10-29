#!/usr/bin/env python3
"""Unit tests for t1_check.py. Standard library only. No native TDLib, no network, no Telegram: a scripted fake transport
stands in for the library. Run with:  python3 -I tools/t1-feasibility/test_t1_check.py
"""
import importlib.util
import io as stdio
import json
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = importlib.util.spec_from_file_location("t1_check", os.path.join(HERE, "t1_check.py"))
t1 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(t1)

CHANNEL_ID = -1001000000001  # synthetic test value
OTHER_CHAT = -1002000000002
CANARIES = {
    "text": "CANARY-MESSAGE-TEXT-8f3a",
    "caption": "CANARY-CAPTION-91bc",
    "sender": "CANARY-SENDER-NAME",
    "phone": "+15550001111",
    "code": "CODE-424242",
    "password": "PASSWORD-CANARY-77",
    "api_hash": "0123456789abcdef0123456789abcdef",
    "other_chat_title": "CANARY-OTHER-CHAT",
    "username": "CANARY-USERNAME",
    "description": "CANARY-DESCRIPTION",
}


def make_home(tmp, with_db=False, channel=CHANNEL_ID, mode_dir=0o700, mode_file=0o600):
    home = os.path.join(tmp, ".twins-t1")
    os.makedirs(home, exist_ok=True)
    os.chmod(home, mode_dir)
    files = {
        "api_id": "123456",
        "api_hash": CANARIES["api_hash"],
        "channel_id": str(channel),
        "db.key": "ab" * 32,
    }
    for name, value in files.items():
        path = os.path.join(home, name)
        with open(path, "w") as handle:
            handle.write(value)
        os.chmod(path, mode_file)
    if with_db:
        os.makedirs(os.path.join(home, "tdlib-db"), exist_ok=True)
        with open(os.path.join(home, "tdlib-db", "marker"), "w") as handle:
            handle.write("x")
    return home


class FakeIO(object):
    def __init__(self, phone=None, code=None, password=None):
        self.lines = []
        self.errors = []
        self.phone = CANARIES["phone"] if phone is None else phone
        self.code = CANARIES["code"] if code is None else code
        self.password = CANARIES["password"] if password is None else password
        self.prompts = {"phone": 0, "code": 0, "password": 0}
        self.now = 0.0

    def out(self, line):
        self.lines.append(line)

    def err(self, line):
        self.errors.append(line)

    def prompt_phone(self):
        self.prompts["phone"] += 1
        return self.phone

    def prompt_code(self):
        self.prompts["code"] += 1
        return self.code

    def prompt_password(self):
        self.prompts["password"] += 1
        return self.password

    def sleep(self, seconds):
        self.now += seconds

    def clock(self):
        self.now += 0.01
        return self.now

    def everything(self):
        return "\n".join(self.lines + self.errors)


class FakeTransport(object):
    """Scripted stand-in for libtdjson."""

    def __init__(self, logged_in=False, good_code=None, has_password=False, good_password=None, phone_error=None,
                 chat_missing_pages=0, member_status="chatMemberStatusMember", protected=True, history_empty=False,
                 extra_updates=None, reprompt_without_error=False, reprompt_phone=False,
                 tdlib_version="1.8.68", tdlib_commit=None, chat_type="supergroup", supergroup_error=None, supergroup_status=...,
                 supergroup_id_mismatch=False):
        self.sequence = []
        self.requests = []
        self.executed = []
        self.queue = []
        self.logged_in = logged_in
        self.good_code = CANARIES["code"] if good_code is None else good_code
        self.has_password = has_password
        self.good_password = CANARIES["password"] if good_password is None else good_password
        self.phone_error = phone_error
        self.chat_missing_pages = chat_missing_pages
        self.member_status = member_status
        self.protected = protected
        self.history_empty = history_empty
        self.extra_updates = extra_updates or []
        self.reprompt_without_error = reprompt_without_error  # Telegram answers "ok" but asks for the code/password again
        self.reprompt_phone = reprompt_phone  # Telegram answers "ok" but asks for the phone number again
        self.tdlib_version = tdlib_version
        self.chat_type = chat_type
        self.supergroup_error = supergroup_error
        self.supergroup_status = supergroup_status
        self.supergroup_id_mismatch = supergroup_id_mismatch
        self.tdlib_commit = t1.PINNED_TDLIB_COMMIT if tdlib_commit is None else tdlib_commit
        self.chat_calls = 0

    def execute(self, request):
        t1.ensure_allowed(request["@type"])
        self.sequence.append(("execute", request["@type"]))
        self.executed.append(request)
        if request["@type"] == "getOption":  # synchronous build information, available before any client exists
            value = {"version": self.tdlib_version, "commit_hash": self.tdlib_commit}.get(request["name"])
            return {"@type": "optionValueString", "value": value} if value is not None else {"@type": "error", "code": 400, "message": "x"}
        return {"@type": "ok"}

    def create_client_id(self):
        return 7

    def _state(self, name):
        self.queue.append({"@type": "updateAuthorizationState", "authorization_state": {"@type": name}})

    def _reply(self, request, body):
        body = dict(body)
        body["@extra"] = request["@extra"]
        self.queue.append(body)

    def send(self, client_id, request):
        t1.ensure_allowed(request["@type"])
        self.sequence.append(("send", request["@type"]))
        self.requests.append(request)
        kind = request["@type"]
        ok = {"@type": "ok"}
        error = lambda code, message: {"@type": "error", "code": code, "message": message}
        if kind == "getOption":
            self._reply(request, {"@type": "optionValueString", "value": "1.8.99"})
            self._state("authorizationStateWaitTdlibParameters")
        elif kind == "setTdlibParameters":
            self._reply(request, ok)
            self._state("authorizationStateReady" if self.logged_in else "authorizationStateWaitPhoneNumber")
        elif kind == "setAuthenticationPhoneNumber":
            if self.phone_error:
                self._reply(request, error(*self.phone_error))
            elif self.reprompt_phone:
                self._reply(request, ok)
                self._state("authorizationStateWaitPhoneNumber")
            else:
                self._reply(request, ok)
                self._state("authorizationStateWaitCode")
        elif kind == "checkAuthenticationCode":
            if self.reprompt_without_error:
                self._reply(request, ok)
                self._state("authorizationStateWaitCode")
            elif request["code"] == self.good_code:
                self._reply(request, ok)
                self._state("authorizationStateWaitPassword" if self.has_password else "authorizationStateReady")
            else:
                self._reply(request, error(400, "PHONE_CODE_INVALID"))
        elif kind == "checkAuthenticationPassword":
            if self.reprompt_without_error:
                self._reply(request, ok)
                self._state("authorizationStateWaitPassword")
            elif request["password"] == self.good_password:
                self._reply(request, ok)
                self._state("authorizationStateReady")
            else:
                self._reply(request, error(400, "PASSWORD_HASH_INVALID"))
        elif kind == "getChat":
            self.chat_calls += 1
            if self.chat_calls <= self.chat_missing_pages:
                self._reply(request, error(400, "Chat not found"))
            else:
                for update in self.extra_updates:  # live updates start arriving once the chat is known
                    self.queue.append(update)
                self.extra_updates = []
                self._reply(
                    request,
                    {
                        "@type": "chat",
                        "id": request["chat_id"],
                        "title": 'Signal "Channel"\n\tname',
                        "type": ({"@type": "chatTypeSupergroup", "supergroup_id": 1000000001, "is_channel": True} if self.chat_type == "supergroup"
                                 else {"@type": "chatTypeBasicGroup", "basic_group_id": 77}),
                        "has_protected_content": self.protected,
                        "last_message": {"id": 5, "content": {"@type": "messageText", "text": {"text": CANARIES["text"]}}},
                    },
                )
        elif kind == "loadChats":
            self._reply(request, ok)
        elif kind == "getSupergroup":
            if self.supergroup_error:
                self._reply(request, error(*self.supergroup_error))
            else:
                status = {"@type": self.member_status} if self.supergroup_status is ... else self.supergroup_status
                body = {"@type": "supergroup", "id": request["supergroup_id"] + (1 if self.supergroup_id_mismatch else 0), "is_channel": True,
                        "usernames": {"editable_username": CANARIES["username"]}, "member_count": 1234, "description": CANARIES["description"]}
                if status is not None:
                    body["status"] = status
                self._reply(request, body)
        elif kind == "getChatHistory":
            messages = [] if self.history_empty else [
                {
                    "@type": "message",
                    "id": 4242,
                    "chat_id": request["chat_id"],
                    "date": 1700000000,
                    "edit_date": 1700000100,
                    "sender_id": {"@type": "messageSenderChat", "chat_id": request["chat_id"]},
                    "content": {"@type": "messageText", "text": {"@type": "formattedText", "text": CANARIES["text"]}, "caption": CANARIES["caption"]},
                }
            ]
            self._reply(request, {"@type": "messages", "total_count": len(messages), "messages": messages})
        elif kind == "logOut":
            self._reply(request, ok)
            self._state("authorizationStateLoggingOut")
            self._state("authorizationStateClosed")
        elif kind == "close":
            self._reply(request, ok)
            self._state("authorizationStateClosed")
        else:
            self._reply(request, ok)

    def receive(self, timeout):
        return self.queue.pop(0) if self.queue else None

    def request_types(self):
        return [r["@type"] for r in self.requests]


def args_for(mode, seconds=None):
    ns = t1.parse_args(["--mode", mode] + (["--seconds", str(seconds)] if seconds is not None else []))
    return ns


class CheckModeTests(unittest.TestCase):
    def test_check_prints_metadata_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(), FakeIO()
            code = t1.run(args_for("check"), transport, io, home)
            self.assertEqual(code, 0, io.everything())
            text = io.everything()
            self.assertIn("authorization=ready", text)
            self.assertIn("channel_id=%d" % CHANNEL_ID, text)
            self.assertIn("type=channel(broadcast)", text)
            self.assertIn("membership=member", text)
            self.assertIn("protected_content=true", text)
            self.assertIn("latest_message: id=4242 date=2023-11-14T22:13:20Z edit_date=2023-11-14T22:15:00Z content_type=messageText", text)
            self.assertIn("events_observable: new=unknown edited=unknown deleted=unknown", text)
            for name, canary in CANARIES.items():
                if name in ("other_chat_title",):
                    continue
                self.assertNotIn(canary, text, "leaked %s" % name)
            # title is sanitised (quotes and control characters removed)
            self.assertIn('title="Signal \'Channel\' name"', text)

    def test_only_allowed_requests_and_logging_disabled_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport = FakeTransport()
            t1.run(args_for("check"), transport, FakeIO(), home)
            self.assertTrue(set(transport.request_types()) <= t1.ALLOWED_REQUESTS)
            self.assertEqual(transport.sequence[0], ("execute", "setLogVerbosityLevel"))
            self.assertEqual(transport.sequence[1], ("execute", "setLogStream"))
            self.assertEqual(transport.executed[0]["new_verbosity_level"], 0)
            self.assertEqual(transport.sequence[2:4], [("execute", "getOption"), ("execute", "getOption")])
            first_send = next(i for i, s in enumerate(transport.sequence) if s[0] == "send")
            self.assertEqual(first_send, 4)  # the library is verified before any client request is made
            self.assertNotIn("logOut", transport.request_types())
            self.assertEqual(transport.request_types()[-1], "close")
            self.assertEqual(transport.requests[-1]["@type"], "close")

    def test_tdlib_parameters_store_no_messages_or_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport = FakeTransport()
            t1.run(args_for("check"), transport, FakeIO(), home)
            params = next(r for r in transport.requests if r["@type"] == "setTdlibParameters")
            self.assertFalse(params["use_message_database"])
            self.assertFalse(params["use_file_database"])
            self.assertFalse(params["use_secret_chats"])
            self.assertEqual(params["device_model"], "TWINS T1 feasibility")
            self.assertTrue(params["database_directory"].startswith(os.path.realpath(home)) or params["database_directory"].startswith(home))
            self.assertEqual(len(__import__("base64").b64decode(params["database_encryption_key"])), 32)

    def test_header_shows_pinned_version_and_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            io = FakeIO()
            self.assertEqual(t1.run(args_for("check"), FakeTransport(), io, home), 0)
            self.assertIn("tdlib=1.8.68 commit=%s" % t1.PINNED_TDLIB_COMMIT[:10], io.lines[0])

    def test_old_tdlib_is_refused_before_any_client_or_prompt(self):
        for old_version in ("1.8.0", "1.8.5", "1.7.9", "0.9.99", "", "garbage", "1.8"):
            with tempfile.TemporaryDirectory() as tmp:
                home = make_home(tmp)
                transport, io = FakeTransport(tdlib_version=old_version), FakeIO()
                self.assertEqual(t1.run(args_for("check"), transport, io, home), 2, old_version)
                self.assertEqual(transport.requests, [], "no client request may be sent")
                self.assertEqual(sum(io.prompts.values()), 0)
                self.assertIn("too old", io.errors[-1])

    def test_unpinned_or_unreported_commit_is_refused(self):
        for commit in ("0" * 40, "", t1.PINNED_TDLIB_COMMIT[:-1] + "1", t1.PINNED_TDLIB_COMMIT.upper() + "x"):
            with tempfile.TemporaryDirectory() as tmp:
                home = make_home(tmp)
                transport, io = FakeTransport(tdlib_commit=commit), FakeIO()
                self.assertEqual(t1.run(args_for("check"), transport, io, home), 2)
                self.assertEqual(transport.requests, [])
                self.assertEqual(sum(io.prompts.values()), 0)
                self.assertIn("not the pinned commit", io.errors[-1])

    def test_newer_tdlib_versions_with_the_pinned_commit_are_accepted(self):
        for version in ("1.8.6", "1.8.68", "1.8.200", "1.9.0", "2.0.0"):
            with tempfile.TemporaryDirectory() as tmp:
                home = make_home(tmp)
                self.assertEqual(t1.run(args_for("check"), FakeTransport(tdlib_version=version), FakeIO(), home), 0, version)

    def test_library_check_also_guards_listen_and_logout(self):
        for mode, extra in (("listen", 10), ("logout", None)):
            with tempfile.TemporaryDirectory() as tmp:
                home = make_home(tmp, with_db=True)
                transport = FakeTransport(logged_in=True, tdlib_version="1.8.0")
                self.assertEqual(t1.run(args_for(mode, extra), transport, FakeIO(), home), 2, mode)
                self.assertEqual(transport.requests, [])
                self.assertTrue(os.path.exists(os.path.join(home, "tdlib-db")), "must not delete anything on a refused library")

    def test_version_parser(self):
        self.assertEqual(t1.parse_version("1.8.68"), (1, 8, 68))
        for bad in (None, "", "1.8", "1.8.x", "v1.8.6", "1.8.6-beta", 168, "1.8.6\n"):
            self.assertIsNone(t1.parse_version(bad), repr(bad))
        self.assertTrue(t1.parse_version("1.8.6") >= t1.MIN_TDLIB and not (t1.parse_version("1.8.5") >= t1.MIN_TDLIB))

    def test_pin_constants(self):
        self.assertRegex(t1.PINNED_TDLIB_COMMIT, r"^[0-9a-f]{40}$")
        self.assertTrue(t1.pinned_library_path().endswith(os.path.join(".twins-t1-build", "install", "lib", "libtdjson.dylib")))
        self.assertFalse(t1.pinned_library_path().startswith(os.path.join(os.path.expanduser("~"), "twins")))

    def test_wrong_code_is_tried_once_and_never_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(good_code="OTHER"), FakeIO()
            code = t1.run(args_for("check"), transport, io, home)
            self.assertEqual(code, 2)
            self.assertEqual(transport.request_types().count("checkAuthenticationCode"), 1)
            self.assertEqual(io.prompts, {"phone": 1, "code": 1, "password": 0})
            self.assertNotIn(CANARIES["code"], io.everything())
            self.assertNotIn(CANARIES["phone"], io.everything())

    def test_phone_request_is_sent_once_even_if_telegram_asks_again_without_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(reprompt_phone=True), FakeIO()
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 2)
            self.assertEqual(transport.request_types().count("setAuthenticationPhoneNumber"), 1)
            self.assertEqual(io.prompts, {"phone": 1, "code": 0, "password": 0})

    def test_code_is_asked_once_even_if_telegram_asks_again_without_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(reprompt_without_error=True), FakeIO()
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 2)
            self.assertEqual(transport.request_types().count("checkAuthenticationCode"), 1)
            self.assertEqual(io.prompts, {"phone": 1, "code": 1, "password": 0})

    def test_password_is_asked_once_even_if_telegram_asks_again_without_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(has_password=True, reprompt_without_error=False), FakeIO()
            # good code, then the password step re-requests the password after an "ok" answer
            original = transport.send

            def send(client_id, request):
                original(client_id, request)
                if request["@type"] == "checkAuthenticationPassword":
                    transport.queue = [m for m in transport.queue if not (m.get("@type") == "updateAuthorizationState")]
                    transport._state("authorizationStateWaitPassword")
                    for m in transport.queue:
                        if m.get("@extra") == request["@extra"]:
                            m["@type"] = "ok"

            transport.send = send
            transport.good_password = CANARIES["password"]
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 2)
            self.assertEqual(transport.request_types().count("checkAuthenticationPassword"), 1)
            self.assertEqual(io.prompts["password"], 1)

    def test_password_is_asked_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(has_password=True, good_password="NOPE"), FakeIO()
            code = t1.run(args_for("check"), transport, io, home)
            self.assertEqual(code, 2)
            self.assertEqual(transport.request_types().count("checkAuthenticationPassword"), 1)
            self.assertEqual(io.prompts["password"], 1)
            self.assertNotIn(CANARIES["password"], io.everything())

    def test_password_success_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(has_password=True), FakeIO()
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 0)
            self.assertEqual(io.prompts, {"phone": 1, "code": 1, "password": 1})
            self.assertNotIn(CANARIES["password"], io.everything())

    def test_flood_wait_stops_without_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(phone_error=(429, "Too Many Requests: retry after 30")), FakeIO()
            code = t1.run(args_for("check"), transport, io, home)
            self.assertEqual(code, 3)
            self.assertEqual(transport.request_types().count("setAuthenticationPhoneNumber"), 1)
            self.assertIn("30", io.errors[-1])
            self.assertEqual(io.prompts["code"], 0)
            self.assertNotIn(CANARIES["phone"], io.everything())

    def test_chat_is_loaded_in_bounded_pages_when_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport = FakeTransport(chat_missing_pages=2)
            self.assertEqual(t1.run(args_for("check"), transport, FakeIO(), home), 0)
            self.assertEqual(transport.request_types().count("loadChats"), 2)

    def test_chat_never_found_is_reported_not_looped(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(chat_missing_pages=10 ** 6), FakeIO()
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 2)
            self.assertLessEqual(transport.request_types().count("getChat"), 2 * t1.MAX_LOAD_PAGES + 1)
            self.assertIn("not found", io.errors[-1])

    def test_non_member_and_empty_history_are_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(member_status="chatMemberStatusLeft", history_empty=True, protected=False), FakeIO()
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 0)
            text = io.everything()
            self.assertIn("membership=left", text)
            self.assertIn("protected_content=false", text)
            self.assertIn("latest_message: none_returned", text)

    def test_bad_inputs_stop_before_any_telegram_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp, mode_file=0o644)
            transport, io = FakeTransport(), FakeIO()
            self.assertEqual(t1.run(args_for("check"), transport, io, home), 2)
            self.assertEqual(transport.sequence, [])
            self.assertEqual(sum(io.prompts.values()), 0)


class MembershipTests(unittest.TestCase):
    """Membership comes from supergroup.status (the CURRENT user's status). No member list is ever requested."""

    def run_check(self, **options):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        home = make_home(tmp.name)
        transport, io = FakeTransport(**options), FakeIO()
        code = t1.run(args_for("check"), transport, io, home)
        return code, transport, io

    def test_each_status_is_reported_from_supergroup_status(self):
        expected = {
            "chatMemberStatusMember": "member",
            "chatMemberStatusAdministrator": "administrator",
            "chatMemberStatusCreator": "creator",
            "chatMemberStatusLeft": "left",
            "chatMemberStatusBanned": "banned",
            "chatMemberStatusRestricted": "restricted",
        }
        for status, name in expected.items():
            code, transport, io = self.run_check(member_status=status)
            self.assertEqual(code, 0, status)
            self.assertIn("membership=%s" % name, io.everything())
            self.assertIn("getSupergroup", transport.request_types())

    def test_request_sequence_is_chat_then_supergroup_then_history_and_nothing_member_related(self):
        code, transport, io = self.run_check()
        self.assertEqual(code, 0)
        types = transport.request_types()
        self.assertEqual([t for t in types if t in ("getChat", "getSupergroup", "getChatHistory")], ["getChat", "getSupergroup", "getChatHistory"])
        supergroup_request = next(r for r in transport.requests if r["@type"] == "getSupergroup")
        self.assertEqual(supergroup_request["supergroup_id"], 1000000001)  # taken from chat.type.supergroup_id
        self.assertEqual(set(supergroup_request.keys()), {"@type", "@extra", "supergroup_id"})
        member_related = {"getChatMember", "getSupergroupMembers", "searchChatMembers", "getChatAdministrators", "getSupergroupFullInfo",
                          "getBasicGroupFullInfo", "getMe", "getUser"}
        self.assertEqual(member_related & set(types), set())

    def test_inaccessible_member_list_error_cannot_occur_because_no_member_request_exists(self):
        # even a transport that would answer every member request with Telegram's "Member list is inaccessible" is never asked
        code, transport, io = self.run_check()
        self.assertEqual(code, 0)
        self.assertNotIn("inaccessible", io.everything().lower())

    def test_membership_is_never_assumed_when_it_cannot_be_determined(self):
        for options in (
            {"supergroup_status": None},                                   # status missing
            {"supergroup_status": {"@type": "chatMemberStatusSomethingNew"}},  # unknown status type
            {"supergroup_status": "member"},                               # wrong shape
            {"supergroup_error": (400, "Supergroup not found")},           # inaccessible
            {"supergroup_error": (400, "Member list is inaccessible")},    # the original failure text, if it ever came back
            {"supergroup_id_mismatch": True},                              # response for another supergroup
            {"chat_type": "basic_group"},                                  # not a channel/supergroup
        ):
            code, transport, io = self.run_check(**options)
            self.assertEqual(code, 2, options)
            self.assertNotIn("membership=", io.everything(), options)      # fail closed: no membership line at all
            self.assertNotIn("getChatHistory", transport.request_types(), options)  # and nothing further is read
            self.assertEqual(sum(io.prompts.values()), 1 + 1 + 0)           # only the normal login prompts (phone, code); no re-login

    def test_inaccessible_chat_fails_closed(self):
        code, transport, io = self.run_check(chat_missing_pages=10 ** 6)
        self.assertEqual(code, 2)
        self.assertNotIn("membership=", io.everything())
        self.assertNotIn("getSupergroup", transport.request_types())

    def test_flood_wait_during_the_supergroup_request_stops_the_run(self):
        code, transport, io = self.run_check(supergroup_error=(429, "Too Many Requests: retry after 45"))
        self.assertEqual(code, 3)
        self.assertEqual(transport.request_types().count("getSupergroup"), 1)
        self.assertIn("45", io.errors[-1])

    def test_nothing_secret_or_content_leaks_from_the_supergroup_object(self):
        code, transport, io = self.run_check()
        self.assertEqual(code, 0)
        text = io.everything()
        for canary in CANARIES.values():
            self.assertNotIn(canary, text)
        self.assertNotIn("1234", text.replace("1000000001", ""))  # member_count is never printed
        for line in io.lines:
            self.assertRegex(line, r"^(tool=|authorization=|channel_id=|membership=|protected_content=|latest_message:|events_observable:)")

    def test_listen_mode_also_resolves_the_chat_without_member_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport = FakeTransport(logged_in=True)
            self.assertEqual(t1.run(args_for("listen", 10), transport, FakeIO(), home), 0)
            self.assertNotIn("getChatMember", transport.request_types())
            self.assertNotIn("getMe", transport.request_types())

    def test_membership_name_reads_only_the_status_type(self):
        holder = {"status": {"@type": "chatMemberStatusMember", "is_member": True, "custom_title": CANARIES["sender"]}, "username": CANARIES["username"]}
        self.assertEqual(t1.membership_name(holder), "member")
        for bad in (None, {}, {"status": None}, {"status": {}}, {"status": {"@type": 5}}, {"status": "chatMemberStatusMember"}, [], "x"):
            self.assertEqual(t1.membership_name(bad), "unknown", repr(bad))


class ListenModeTests(unittest.TestCase):
    def updates(self):
        text = {"@type": "formattedText", "text": CANARIES["text"]}
        return [
            {"@type": "updateNewMessage", "message": {"id": 11, "chat_id": CHANNEL_ID, "content": {"@type": "messageText", "text": text}, "sender_id": {"@type": "messageSenderChat", "chat_id": CHANNEL_ID}}},
            {"@type": "updateNewMessage", "message": {"id": 12, "chat_id": OTHER_CHAT, "content": {"@type": "messageText", "text": text}}},
            {"@type": "updateMessageEdited", "chat_id": CHANNEL_ID, "message_id": 11, "edit_date": 1700000300},
            {"@type": "updateDeleteMessages", "chat_id": CHANNEL_ID, "message_ids": [11], "is_permanent": True, "from_cache": False},
            {"@type": "updateDeleteMessages", "chat_id": CHANNEL_ID, "message_ids": [99], "is_permanent": False, "from_cache": True},
            {"@type": "updateChatTitle", "chat_id": OTHER_CHAT, "title": CANARIES["other_chat_title"]},
        ]

    def test_listen_prints_only_event_kinds_and_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(logged_in=True, extra_updates=self.updates()), FakeIO()
            self.assertEqual(t1.run(args_for("listen", 10), transport, io, home), 0)
            text = io.everything()
            self.assertIn("new ids=11 content_type=messageText", text)
            self.assertIn("edited ids=11", text)
            self.assertIn("deleted ids=11", text)
            self.assertNotIn("ids=12", text)
            self.assertNotIn("ids=99", text)
            self.assertIn("events_observable: new=seen edited=seen deleted=seen", text)
            for canary in CANARIES.values():
                self.assertNotIn(canary, text)
            self.assertEqual(sum(io.prompts.values()), 0)

    def test_listen_reports_not_seen(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(logged_in=True), FakeIO()
            self.assertEqual(t1.run(args_for("listen", 10), transport, io, home), 0)
            self.assertIn("events_observable: new=not_seen edited=not_seen deleted=not_seen", io.everything())

    def test_listen_never_logs_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            transport, io = FakeTransport(logged_in=False), FakeIO()
            self.assertEqual(t1.run(args_for("listen", 10), transport, io, home), 2)
            self.assertEqual(sum(io.prompts.values()), 0)
            self.assertNotIn("setAuthenticationPhoneNumber", transport.request_types())


class LogoutModeTests(unittest.TestCase):
    def test_logout_invalidates_and_deletes_only_the_session_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp, with_db=True)
            transport, io = FakeTransport(logged_in=True), FakeIO()
            self.assertEqual(t1.run(args_for("logout"), transport, io, home), 0)
            self.assertEqual(transport.request_types().count("logOut"), 1)
            self.assertFalse(os.path.exists(os.path.join(home, "tdlib-db")))
            self.assertTrue(os.path.exists(os.path.join(home, "api_hash")))  # the user removes the rest with rm -rf
            self.assertIn("server_side_logout=done local_session_deleted=yes", io.everything())
            self.assertIn("Settings > Devices", io.everything())
            self.assertEqual(sum(io.prompts.values()), 0)

    def test_logout_with_dead_session_still_cleans_up_without_prompting(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp, with_db=True)
            transport, io = FakeTransport(logged_in=False), FakeIO()
            self.assertEqual(t1.run(args_for("logout"), transport, io, home), 0)
            self.assertNotIn("logOut", transport.request_types())
            self.assertFalse(os.path.exists(os.path.join(home, "tdlib-db")))
            self.assertIn("server_side_logout=not_needed", io.everything())
            self.assertEqual(sum(io.prompts.values()), 0)

    def test_logout_without_local_session_does_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp, with_db=False)
            transport, io = FakeTransport(logged_in=True), FakeIO()
            self.assertEqual(t1.run(args_for("logout"), transport, io, home), 0)
            self.assertEqual(transport.sequence, [])

    def test_delete_refuses_symlinked_session_dir(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            elsewhere = os.path.join(tmp, "important")
            os.makedirs(elsewhere)
            with open(os.path.join(elsewhere, "keep.txt"), "w") as handle:
                handle.write("keep")
            os.symlink(elsewhere, os.path.join(home, "tdlib-db"))
            with self.assertRaises(t1.T1Error):
                t1.delete_session_dir(home)
            self.assertTrue(os.path.exists(os.path.join(elsewhere, "keep.txt")))


class ReductionTests(unittest.TestCase):
    def test_reduce_message_never_emits_text(self):
        message = {
            "id": 77, "chat_id": CHANNEL_ID, "date": 1700000000, "edit_date": 0,
            "sender_id": {"@type": "messageSenderUser", "user_id": 5, "name": CANARIES["sender"]},
            "content": {"@type": "messagePhoto", "caption": {"text": CANARIES["caption"]}, "text": CANARIES["text"]},
            "reply_markup": {"text": CANARIES["text"]},
        }
        reduced = t1.reduce_message(message)
        self.assertEqual(set(reduced.keys()), {"id", "date", "edit_date", "content_type"})
        self.assertEqual(reduced["content_type"], "messagePhoto")
        self.assertIsNone(reduced["edit_date"])
        blob = json.dumps(reduced)
        for canary in CANARIES.values():
            self.assertNotIn(canary, blob)

    def test_content_type_name_is_validated(self):
        for hostile in ("messageText; DROP", "x" * 200, "a b", "", None, 5, {"x": 1}, ["messageText"], "message\nText", "messageText\n", "messageText\r\n", "messageText\n[injected]"):
            reduced = t1.reduce_message({"id": 1, "date": 1, "content": {"@type": hostile}})
            self.assertEqual(reduced["content_type"], "unknown", hostile)

    def test_bad_shapes_raise(self):
        for bad in (None, [], "x", {"id": "1"}, {"id": True}, {}):
            with self.assertRaises(t1.T1Error):
                t1.reduce_message(bad)

    def test_reduce_chat_keeps_only_public_fields(self):
        chat = {"id": CHANNEL_ID, "title": "A\x00B C" + "x" * 200, "has_protected_content": True,
                "type": {"@type": "chatTypeSupergroup", "supergroup_id": 5}, "last_message": {"content": {"text": CANARIES["text"]}}}
        reduced = t1.reduce_chat(chat)
        self.assertEqual(set(reduced.keys()), {"id", "title", "protected", "type"})
        self.assertLessEqual(len(reduced["title"]), 80)
        self.assertNotIn("\x00", reduced["title"])
        self.assertNotIn(CANARIES["text"], json.dumps(reduced))
        self.assertIs(t1.reduce_chat({"id": 1, "has_protected_content": "yes"})["protected"], False)

    def test_classify_update_ignores_other_chats_and_cache_deletes(self):
        update = {"@type": "updateDeleteMessages", "chat_id": CHANNEL_ID, "message_ids": list(range(100)) , "is_permanent": True, "from_cache": False}
        events = t1.classify_update(update, CHANNEL_ID)
        self.assertEqual(len(events[0]["ids"]), 20)
        self.assertEqual(t1.classify_update(dict(update, chat_id=OTHER_CHAT), CHANNEL_ID), [])
        self.assertEqual(t1.classify_update(dict(update, from_cache=True), CHANNEL_ID), [])
        self.assertEqual(t1.classify_update(dict(update, is_permanent=False), CHANNEL_ID), [])
        self.assertEqual(t1.classify_update("nope", CHANNEL_ID), [])
        message = {"@type": "updateNewMessage", "message": {"id": 5, "chat_id": CHANNEL_ID, "content": {"@type": "messageText", "text": CANARIES["text"]}}}
        self.assertNotIn(CANARIES["text"], json.dumps(t1.classify_update(message, CHANNEL_ID)))

    def test_membership_names(self):
        for status, name in (("chatMemberStatusMember", "member"), ("chatMemberStatusLeft", "left"), ("chatMemberStatusAdministrator", "administrator"),
                             ("chatMemberStatusCreator", "creator"), ("chatMemberStatusBanned", "banned"), ("something", "unknown")):
            self.assertEqual(t1.membership_name({"status": {"@type": status}}), name)
        self.assertEqual(t1.membership_name(None), "unknown")


class ArgumentTests(unittest.TestCase):
    def test_defaults_and_listen_bounds(self):
        self.assertEqual(t1.parse_args([]).mode, "check")
        self.assertEqual(t1.parse_args(["--mode", "listen"]).seconds, 600)
        self.assertEqual(t1.parse_args(["--mode", "listen", "--seconds", "900"]).seconds, 900)
        self.assertEqual(t1.parse_args(["--mode", "listen", "--seconds", "10"]).seconds, 10)

    def test_rejections(self):
        bad = (["--mode", "listen", "--seconds", "901"], ["--mode", "listen", "--seconds", "9"], ["--mode", "listen", "--seconds", "-5"],
               ["--mode", "check", "--seconds", "30"], ["--mode", "logout", "--seconds", "30"], ["--mode", "send"], ["--mode", "history"],
               ["--phone", "+1"], ["--code", "1"], ["--password", "x"], ["--mode", "listen", "--seconds", "abc"])
        for argv in bad:
            with mock.patch("sys.stderr", new=stdio.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    t1.parse_args(argv)
            self.assertNotEqual(raised.exception.code, 0, argv)

    def test_no_secret_bearing_options_exist(self):
        options = " ".join(a for action in t1.build_parser()._actions for a in action.option_strings)
        for word in ("phone", "code", "password", "hash", "token", "secret", "text"):
            self.assertNotIn(word, options)


class InputTests(unittest.TestCase):
    def test_good_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            inputs = t1.load_inputs(make_home(tmp))
            self.assertEqual(inputs["channel_id"], CHANNEL_ID)
            self.assertEqual(inputs["api_id"], 123456)

    def test_permission_and_type_checks_do_not_leak_values(self):
        cases = (dict(mode_dir=0o755), dict(mode_file=0o644), dict(mode_file=0o640), dict(channel=1234567), dict(channel="-100abc"))
        for case in cases:
            with tempfile.TemporaryDirectory() as tmp:
                home = make_home(tmp, **case)
                with self.assertRaises(t1.T1Error) as raised:
                    t1.load_inputs(home)
                message = str(raised.exception)
                for canary in (CANARIES["api_hash"], "ab" * 32):
                    self.assertNotIn(canary, message)

    def test_format_checks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            for name, bad in (("api_hash", "short"), ("db.key", "zz" * 32), ("api_id", "12ab"), ("channel_id", "-1001")):
                path = os.path.join(home, name)
                with open(path) as handle:
                    original = handle.read()
                with open(path, "w") as handle:
                    handle.write(bad)
                with self.assertRaises(t1.T1Error):
                    t1.load_inputs(home)
                with open(path, "w") as handle:
                    handle.write(original)

    def test_symlinked_input_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = make_home(tmp)
            target = os.path.join(tmp, "real_api_hash")
            os.rename(os.path.join(home, "api_hash"), target)
            os.symlink(target, os.path.join(home, "api_hash"))
            with self.assertRaises(t1.T1Error):
                t1.load_inputs(home)

    def test_missing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(t1.T1Error):
                t1.load_inputs(os.path.join(tmp, "missing"))


class GuardTests(unittest.TestCase):
    def test_disallowed_request_types_cannot_be_built(self):
        for forbidden in ("sendMessage", "forwardMessages", "joinChat", "leaveChat", "deleteMessages", "viewMessages", "addChatMember",
                          "openChat", "setChatTitle", "getChatHistoryX", "searchPublicChat", "sendMessageAlbum",
                          # member-list and per-member lookups are not allowed in any form
                          "getChatMember", "getSupergroupMembers", "searchChatMembers", "getChatAdministrators", "getSupergroupFullInfo",
                          "getBasicGroupFullInfo", "getMe", "getUser", "getChatNotificationSettingsExceptions"):
            with self.assertRaises(t1.T1Error):
                t1.req(forbidden)

    def test_allowlist_contents(self):
        self.assertEqual(len(t1.ALLOWED_REQUESTS), 13)
        for name in t1.ALLOWED_REQUESTS:
            self.assertFalse(name.startswith("send") or name.startswith("forward") or name.startswith("delete") or name.startswith("join"))

    def test_missing_library_is_a_clear_error(self):
        with mock.patch("os.path.isfile", return_value=False):
            with self.assertRaises(t1.T1Error) as raised:
                t1.TdTransport()
        self.assertIn("TDLIB_PINNED_BUILD", str(raised.exception))

    def test_no_fallback_to_other_tdlib_copies(self):
        tried = []
        real_isfile = os.path.isfile

        def spy(path):
            tried.append(path)
            return False

        with mock.patch("os.path.isfile", side_effect=spy), mock.patch.dict(os.environ, {"TWINS_T1_TDJSON": "/explicit/override.dylib"}):
            with self.assertRaises(t1.T1Error):
                t1.TdTransport()
        self.assertEqual(tried, ["/explicit/override.dylib", t1.pinned_library_path()])
        self.assertFalse(any("homebrew" in path or "/usr/local" in path for path in tried))
        self.assertTrue(real_isfile)

    def test_check_refuses_to_run_without_a_terminal(self):
        fake_stdin = mock.Mock()
        fake_stdin.isatty.return_value = False
        with mock.patch("sys.stdin", fake_stdin), mock.patch("sys.stderr", new=stdio.StringIO()) as captured:
            code = t1.main(["--mode", "check"])
        self.assertEqual(code, 2)
        self.assertIn("interactive Terminal", captured.getvalue())

    def test_module_has_no_import_time_side_effects(self):
        self.assertTrue(callable(t1.main))
        self.assertEqual(oct(stat.S_IMODE(os.stat(os.path.join(HERE, "t1_check.py")).st_mode) & 0o022), "0o0")


class LiveTradingGuard(unittest.TestCase):
    """The shared LIVE_TRADING guard (same contract as the TypeScript and capture-client guards: tests/fixtures/liveGuard/contract.json)."""

    CONTRACT = os.path.join(HERE, "..", "..", "tests", "fixtures", "liveGuard", "contract.json")

    def _run(self, env):
        fake_stdin = mock.Mock()
        fake_stdin.isatty.return_value = False
        with mock.patch.dict(os.environ, env, clear=True), mock.patch("sys.stdin", fake_stdin), mock.patch("sys.stderr", new=stdio.StringIO()) as captured:
            try:
                code = t1.main(["--mode", "check"])
            except SystemExit as exit_:
                return exit_.code, captured.getvalue()
        return code, captured.getvalue()

    def test_every_contract_case(self):
        with open(self.CONTRACT) as handle:
            contract = json.load(handle)
        self.assertEqual(contract["failureContract"]["exitCode"], 81)
        for case in contract["cases"]:
            code, err = self._run(case["env"])
            if case["ok"]:
                self.assertEqual(code, 2, case["name"])  # past the guard: the ordinary no-terminal refusal
                self.assertNotIn("live_guard", err, case["name"])
            else:
                self.assertEqual(code, 81, case["name"])
                line = json.loads(err.strip())
                self.assertEqual(line["event"], "live_guard.refused", case["name"])
                self.assertEqual(line["process"], "t1-check", case["name"])
                self.assertEqual(line["reasons"], case["reasons"], case["name"])
                for value in case["env"].values():
                    if value:
                        self.assertNotIn('"%s"' % value, err, case["name"])

    def test_refuses_before_anything_else_happens(self):
        with mock.patch.object(t1, "TdTransport", side_effect=AssertionError("must not be constructed")):
            code, _ = self._run({"LIVE_TRADING": "true"})
        self.assertEqual(code, 81)

    def test_fails_closed_when_the_shared_guard_cannot_be_loaded(self):
        with mock.patch("importlib.util.spec_from_file_location", side_effect=OSError("missing")):
            code, err = self._run({})
        self.assertEqual(code, 81)
        self.assertEqual(json.loads(err.strip())["reasons"], [contract_unavailable()])


def contract_unavailable():
    with open(LiveTradingGuard.CONTRACT) as handle:
        return json.load(handle)["failureContract"]["unavailableReason"]


if __name__ == "__main__":
    unittest.main(verbosity=1)
