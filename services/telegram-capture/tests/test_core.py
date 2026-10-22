import json
import os
import re
import unittest

from fakes import CHAT, OTHER_CHAT, POISON, Env, tdmsg, make_env
from twins_capture import mapping
from twins_capture.config import ConfigError, load_config, parse_chat_ids, validate_ingest_url
from twins_capture.safelog import SafeLogger
from twins_capture.session import AuthFailure, ChatUnavailable, Session, check_session_dir
from twins_capture.tdlib import ALLOWED_REQUESTS, CaptureError, FloodWait, ensure_allowed, req, verify_library


class AllowlistRuntime(unittest.TestCase):
    def test_forbidden_requests_are_refused(self):
        for name in ("sendMessage", "forwardMessages", "joinChat", "leaveChat", "deleteMessages", "viewMessages", "openChat", "getChatMember", "getChatHistory", "downloadFile", "toggleChatIsMuted"):
            with self.assertRaises(CaptureError, msg=name):
                ensure_allowed(name)

    def test_a_request_for_an_unapproved_chat_is_refused(self):
        with self.assertRaises(CaptureError):
            req(frozenset([CHAT]), "getMessage", chat_id=OTHER_CHAT, message_id=1 << 20)
        self.assertEqual(req(frozenset([CHAT]), "getMessage", chat_id=CHAT, message_id=1 << 20)["chat_id"], CHAT)

    def test_exactly_thirteen_request_types(self):
        self.assertEqual(len(ALLOWED_REQUESTS), 13)

    def test_the_transport_refuses_forbidden_requests_before_sending(self):
        env = Env()
        with self.assertRaises(CaptureError):
            env.transport.send(1, {"@type": "sendMessage"})
        env.close()


class Library(unittest.TestCase):
    def test_pinned_build_is_accepted(self):
        env = Env()
        self.assertEqual(verify_library(env.transport)[0], "1.8.68")
        env.close()

    def test_wrong_commit_or_old_version_is_refused(self):
        for kwargs in ({"commit": "0" * 40}, {"version": "1.8.0"}, {"version": "garbage"}):
            env = Env(**kwargs)
            with self.assertRaises(CaptureError):
                verify_library(env.transport)
            env.close()


class Mapping(unittest.TestCase):
    def test_server_ids_are_shifted_and_local_ids_refused(self):
        self.assertEqual(mapping.server_message_id(837678 << 20), 837678)
        for bad in (0, -5, 837678, (837678 << 20) + 1, True, None, "5"):
            self.assertIsNone(mapping.server_message_id(bad))

    def test_text_message_with_entities(self):
        entities = [{"offset": 0, "length": 3, "type": {"@type": "textEntityTypeBold"}}, {"offset": 4, "length": 2, "type": {"@type": "textEntityTypeTextUrl", "url": "https://example.com/x"}}, {"offset": 7, "length": 1, "type": {"@type": "textEntityTypePreCode", "language": "py"}}]
        out, reason = mapping.map_message(tdmsg(CHAT, 77, "BUY X", entities=entities))
        self.assertIsNone(reason)
        self.assertEqual(out["id"], 77)
        self.assertEqual([e["type"] for e in out["entities"]], ["bold", "text_url", "pre_code"])
        self.assertEqual(out["entities"][1]["url"], "https://example.com/x")
        self.assertEqual(out["entities"][2]["language"], "py")
        self.assertNotIn("editDate", out)

    def test_caption_is_the_text_and_media_kind_is_named(self):
        out, _ = mapping.map_message(tdmsg(CHAT, 5, "caption text", ctype="messageVideoNote"))
        self.assertEqual((out["text"], out["media"]), ("caption text", {"kind": "video_note"}))

    def test_unsendable_messages_have_a_content_free_reason(self):
        self.assertEqual(mapping.map_message(tdmsg(CHAT, 5, "   "))[1], "no_text")
        self.assertEqual(mapping.map_message(tdmsg(CHAT, 5, "x" * 20001))[1], "text_too_long")
        local = tdmsg(CHAT, 5, "x"); local["id"] = 5
        self.assertEqual(mapping.map_message(local)[1], "not_a_server_message")
        self.assertEqual(mapping.map_message("nope")[1], "bad_shape")

    def test_edit_date_only_when_not_before_date(self):
        self.assertEqual(mapping.map_message(tdmsg(CHAT, 5, "x", date=100, edit=150))[0]["editDate"], 150)
        self.assertNotIn("editDate", mapping.map_message(tdmsg(CHAT, 5, "x", date=100, edit=50))[0])

    def test_classify_new_edit_delete_for_approved_chat_only(self):
        approved = frozenset([CHAT])
        self.assertEqual(mapping.classify_update({"@type": "updateNewMessage", "message": tdmsg(CHAT, 1, "a")}, approved)[0]["action"], "new")
        self.assertEqual(mapping.classify_update({"@type": "updateNewMessage", "message": tdmsg(OTHER_CHAT, 1, "a")}, approved), [])
        self.assertEqual(mapping.classify_update({"@type": "updateMessageEdited", "chat_id": CHAT, "message_id": 1 << 20}, approved)[0]["action"], "edited")
        self.assertEqual(mapping.classify_update({"@type": "updateMessageEdited", "chat_id": OTHER_CHAT, "message_id": 1 << 20}, approved), [])
        gone = {"@type": "updateDeleteMessages", "chat_id": CHAT, "message_ids": [3 << 20, 2 << 20, 3 << 20, 99], "is_permanent": True, "from_cache": False}
        self.assertEqual(mapping.classify_update(gone, approved)[0]["ids"], [2, 3])
        for change in ({"is_permanent": False}, {"from_cache": True}, {"chat_id": OTHER_CHAT}):
            self.assertEqual(mapping.classify_update(dict(gone, **change), approved), [], change)
        self.assertEqual(mapping.classify_update({"@type": "updateChatTitle"}, approved), [])

    def test_payload_shape(self):
        body = mapping.build_payload("deleted", CHAT, "2026-10-22T00:00:00Z", ids=[2, 3])
        self.assertEqual(body, {"schemaVersion": 1, "captureMethod": "api_live", "chat": {"id": CHAT, "type": "channel"}, "clientObservedAt": "2026-10-22T00:00:00Z", "event": "delete", "deletedMessageIds": [2, 3]})
        body = mapping.build_payload("message", CHAT, "2026-10-22T00:00:00Z", message={"id": 1, "date": 2})
        self.assertEqual((body["event"], body["messages"]), ("message", [{"id": 1, "date": 2}]))


class SessionBehaviour(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.session = Session(self.env.transport, self.env.cfg, self.env.sink, self.env.log, self.env.state, self.env.clock, self.env.clock.sleep)
        self.session.ensure_ready(None)
        self.session.resolve_chats()

    def tearDown(self):
        self.env.close()

    def run_until_idle(self, seconds=3):
        end = self.env.clock() + seconds
        self.session.run(lambda: self.env.clock() >= end)

    def test_ready_session_uses_only_allowlisted_requests_and_never_a_login_request(self):
        kinds = {r["@type"] for r in self.env.transport.sent}
        self.assertLessEqual(kinds, ALLOWED_REQUESTS)
        self.assertFalse(kinds & {"setAuthenticationPhoneNumber", "checkAuthenticationCode", "checkAuthenticationPassword", "logOut"})

    def test_tdlib_parameters_are_the_privacy_minimal_set(self):
        params = next(r for r in self.env.transport.sent if r["@type"] == "setTdlibParameters")
        self.assertEqual((params["use_message_database"], params["use_file_database"], params["use_secret_chats"]), (False, False, False))
        self.assertEqual(params["database_directory"], self.env.session_dir)
        self.assertEqual(params["database_encryption_key"], self.env.cfg.db_key_b64)

    def test_new_message_is_posted_once_as_api_live(self):
        self.env.transport.inbox.append({"@type": "updateNewMessage", "message": tdmsg(CHAT, 42, "hello")})
        self.run_until_idle()
        self.assertEqual(len(self.env.poster.bodies), 1)
        body = self.env.poster.bodies[0]
        self.assertEqual((body["event"], body["captureMethod"], body["messages"][0]["id"], body["messages"][0]["text"]), ("message", "api_live", 42, "hello"))

    def test_other_chats_are_never_posted_and_never_asked_about(self):
        self.env.transport.inbox.append({"@type": "updateNewMessage", "message": tdmsg(OTHER_CHAT, 42, "hello")})
        self.env.transport.inbox.append({"@type": "updateMessageEdited", "chat_id": OTHER_CHAT, "message_id": 42 << 20})
        self.run_until_idle()
        self.assertEqual(self.env.poster.bodies, [])
        self.assertTrue(all(r.get("chat_id", CHAT) == CHAT for r in self.env.transport.sent))

    def test_edit_fetches_the_message_and_posts_a_revision_with_edit_date(self):
        self.env.transport.messages[(CHAT, 42 << 20)] = tdmsg(CHAT, 42, "edited text", date=1_760_000_000, edit=1_760_000_100)
        self.env.transport.inbox.append({"@type": "updateMessageEdited", "chat_id": CHAT, "message_id": 42 << 20})
        self.run_until_idle()
        sent = [r for r in self.env.transport.sent if r["@type"] == "getMessage"]
        self.assertEqual([(r["chat_id"], r["message_id"]) for r in sent], [(CHAT, 42 << 20)])
        message = self.env.poster.bodies[0]["messages"][0]
        self.assertEqual((message["id"], message["editDate"], message["text"]), (42, 1_760_000_100, "edited text"))

    def test_edit_of_a_vanished_message_is_skipped_quietly(self):
        self.env.transport.inbox.append({"@type": "updateMessageEdited", "chat_id": CHAT, "message_id": 43 << 20})
        self.run_until_idle()
        self.assertEqual(self.env.poster.bodies, [])
        self.assertIn("message_gone", [r.get("reason") for r in self.env.logs()])

    def test_delete_posts_one_delete_event_with_unique_server_ids(self):
        self.env.transport.inbox.append({"@type": "updateDeleteMessages", "chat_id": CHAT, "message_ids": [5 << 20, 4 << 20], "is_permanent": True, "from_cache": False})
        self.run_until_idle()
        body = self.env.poster.bodies[0]
        self.assertEqual((body["event"], body["deletedMessageIds"]), ("delete", [4, 5]))
        self.assertNotIn("messages", body)

    def test_cache_eviction_is_not_a_deletion(self):
        self.env.transport.inbox.append({"@type": "updateDeleteMessages", "chat_id": CHAT, "message_ids": [5 << 20], "is_permanent": True, "from_cache": True})
        self.run_until_idle()
        self.assertEqual(self.env.poster.bodies, [])

    def test_the_session_never_issues_read_marking_or_send_requests(self):
        self.env.transport.inbox.append({"@type": "updateNewMessage", "message": tdmsg(CHAT, 42, "hello")})
        self.run_until_idle()
        for request in self.env.transport.sent:
            self.assertNotRegex(request["@type"], r"^(send|forward|join|leave|delete|view|open|close(?!$)|add|set(?!TdlibParameters|Log))")

    def test_revoked_session_stops_with_auth_failure(self):
        self.env.transport.push_state("authorizationStateLoggingOut")
        with self.assertRaises(AuthFailure):
            self.run_until_idle()

    def test_flood_wait_error_is_raised_with_seconds_and_never_retried(self):
        self.env.transport.errors["getMessage"] = (429, "Too Many Requests: retry after 37")
        self.env.transport.inbox.append({"@type": "updateMessageEdited", "chat_id": CHAT, "message_id": 42 << 20})
        with self.assertRaises(FloodWait) as ctx:
            self.run_until_idle()
        self.assertEqual(ctx.exception.seconds, 37)
        self.assertEqual(len([r for r in self.env.transport.sent if r["@type"] == "getMessage"]), 1)


class ChannelChecks(unittest.TestCase):
    def build(self, **kwargs):
        env = Env(**kwargs)
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        session.ensure_ready(None)
        return env, session

    def test_protected_content_pauses_and_is_recorded(self):
        env, session = self.build(protected=True)
        with self.assertRaises(ChatUnavailable) as ctx:
            session.resolve_chats()
        self.assertEqual(ctx.exception.reason, "protected_content")
        self.assertIs(env.state.protected_content(), True)
        env.close()

    def test_a_change_of_the_flag_is_logged(self):
        env, session = self.build()
        session.resolve_chats()
        env.transport.protected = False
        env.state.set_protected_content(True)
        session.resolve_chats()
        self.assertIn("capture.protected_content_changed", [r["event"] for r in env.logs()])
        env.close()

    def test_not_a_member_is_refused(self):
        env, session = self.build(member="chatMemberStatusLeft")
        with self.assertRaises(ChatUnavailable):
            session.resolve_chats()
        env.close()

    def test_no_member_list_request_is_ever_made(self):
        env, session = self.build()
        session.resolve_chats()
        self.assertEqual({r["@type"] for r in env.transport.sent} - {"getOption", "setTdlibParameters"}, {"getChat", "getSupergroup"})
        env.close()


class Authorization(unittest.TestCase):
    def test_service_never_answers_a_code_prompt(self):
        env = Env(ready=False)
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        with self.assertRaises(AuthFailure) as ctx:
            session.ensure_ready(None)
        self.assertEqual(ctx.exception.reason, "login_required")
        self.assertFalse({r["@type"] for r in env.transport.sent} & {"setAuthenticationPhoneNumber", "checkAuthenticationCode", "checkAuthenticationPassword"})
        env.close()

    def test_owner_login_mode_answers_each_prompt_at_most_once(self):
        env = Env(ready=False)
        prompts = []

        class IO(object):
            def prompt_phone(self): prompts.append("phone"); return "+15550001111"
            def prompt_code(self): prompts.append("code"); return "12345"
            def prompt_password(self): prompts.append("password"); return "pw"

        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        session.ensure_ready(IO())
        self.assertEqual(prompts, ["code"])
        self.assertEqual(session.auth_state, "authorizationStateReady")
        env.close()

    def test_a_rejected_code_is_not_asked_twice(self):
        env = Env(ready=False)
        env.transport.push_state = lambda state: env.transport.inbox.append({"@type": "updateAuthorizationState", "authorization_state": {"@type": "authorizationStateWaitCode" if state == "authorizationStateReady" else state}})

        class IO(object):
            n = 0
            def prompt_phone(self): return "+15550001111"
            def prompt_password(self): return "pw"
            def prompt_code(self): IO.n += 1; return "1"

        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        with self.assertRaises(AuthFailure):
            session.ensure_ready(IO())
        self.assertEqual(IO.n, 1)
        env.close()

    def test_unauthorized_error_code_is_an_auth_failure(self):
        env = Env()
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        env.transport.errors["getOption"] = (401, "Unauthorized")
        with self.assertRaises(AuthFailure):
            session.ensure_ready(None)
        env.close()


class ConfigRules(unittest.TestCase):
    def test_all_six_variables_are_required_and_nothing_is_hardcoded(self):
        base = make_env("/tmp/x", "/tmp/y")
        for name in ("TWINS_TELEGRAM_API_ID", "TWINS_TELEGRAM_API_HASH", "TWINS_TELEGRAM_SESSION_DB_KEY", "TWINS_TELEGRAM_ALLOWED_CHAT_IDS", "TWINS_CAPTURE_INGEST_TOKEN", "TWINS_CAPTURE_INGEST_URL"):
            env = dict(base); del env[name]
            with self.assertRaises(ConfigError, msg=name):
                load_config(env)

    def test_errors_never_contain_the_values(self):
        bad = make_env("/tmp/x", "/tmp/y", TWINS_TELEGRAM_API_HASH="SECRETVALUE", TWINS_CAPTURE_INGEST_TOKEN="short-SECRETVALUE")
        with self.assertRaises(ConfigError) as ctx:
            load_config(bad)
        self.assertNotIn("SECRETVALUE", str(ctx.exception))

    def test_repr_is_redacted(self):
        self.assertEqual(repr(load_config(make_env("/tmp/x", "/tmp/y"))), "Config(<redacted>)")

    def test_chat_ids_are_numeric_channel_ids_only(self):
        self.assertEqual(parse_chat_ids("-1001000000001, -1002000000002"), frozenset([-1001000000001, -1002000000002]))
        for bad in ("", "mychannel", "@chan", "*", "-1001000000001,-1001000000001", "12345", "-100123", "-1001000000001,x"):
            with self.assertRaises(ConfigError, msg=bad):
                parse_chat_ids(bad)

    def test_ingest_url_must_be_internal(self):
        for good in ("http://api:4000", "http://api:4000/internal/ingest/telegram-user", "http://127.0.0.1:4110", "http://10.0.1.5:4000", "http://localhost:4000"):
            validate_ingest_url(good)
        for bad in ("https://example.com", "http://8.8.8.8", "http://api.example.com:4000", "ftp://api", "http://u:p@api", "http://api:4000/other", "http://api:4000?x=1", "javascript:alert(1)"):
            with self.assertRaises(ConfigError, msg=bad):
                validate_ingest_url(bad)

    def test_session_dir_must_be_private(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "db")
            check_session_dir(path)
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o700)
            os.chmod(path, 0o755)
            with self.assertRaises(CaptureError):
                check_session_dir(path)
            link = os.path.join(tmp, "ln")
            os.symlink(tmp, link)
            with self.assertRaises(CaptureError):
                check_session_dir(link)


class NoContentInOutput(unittest.TestCase):
    def test_poison_text_never_reaches_any_log_error_or_state(self):
        env = Env()
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        session.ensure_ready(None)
        session.resolve_chats()
        env.transport.messages[(CHAT, 8 << 20)] = tdmsg(CHAT, 8, POISON, edit=1_760_000_100)
        env.transport.inbox.append({"@type": "updateNewMessage", "message": tdmsg(CHAT, 7, POISON)})
        env.transport.inbox.append({"@type": "updateMessageEdited", "chat_id": CHAT, "message_id": 8 << 20})
        env.transport.inbox.append({"@type": "updateNewMessage", "message": tdmsg(CHAT, 9, POISON * 1000)})  # too long: skipped with a reason only
        env.poster.statuses.extend([500, 400, 202])
        end = env.clock() + 400
        session.run(lambda: env.clock() >= end)
        visible = env.stream.getvalue()
        for entry in os.listdir(env.state_dir):
            with open(os.path.join(env.state_dir, entry)) as handle:
                visible += handle.read()
        self.assertNotIn("POISON", visible)
        self.assertNotIn("9876543210", visible)
        self.assertGreater(len(env.logs()), 3)
        env.close()

    def test_the_logger_refuses_unlisted_fields_and_free_text(self):
        import io
        log = SafeLogger(io.StringIO())
        for bad in ({"text": "x"}, {"title": "x"}, {"reason": "has spaces and text"}, {"reason": "x" * 80}, {"count": "5"}, {"count": True}):
            with self.assertRaises(ValueError, msg=bad):
                log.log("capture.test", **bad)
        with self.assertRaises(ValueError):
            log.log("Bad Event")


if __name__ == "__main__":
    unittest.main()
