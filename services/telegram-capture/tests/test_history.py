import json
import unittest

from fakes import CHAT, OTHER_CHAT, POISON, Env, tdmsg
from twins_capture import history
from twins_capture.history import EXIT_IMPORT_FAILED, EXIT_WINDOW_MISMATCH, HISTORY_MAX_DAYS, HISTORY_MAX_MESSAGES, read_window, run_history, summarize
from twins_capture.service import EXIT_AUTH, EXIT_BLOCKED, EXIT_CHAT, EXIT_EGRESS, EXIT_OK
from twins_capture.session import Session
from twins_capture.tdlib import HISTORY_PAGE_LIMIT

DAY = 86400


def channel(env, count, newest_age_days=0.0, spacing=600, text="signal"):
    """`count` text messages, server ids 100.., oldest first; the newest is `newest_age_days` old; each earlier one `spacing` seconds before."""
    now = int(env.clock())
    newest = now - int(newest_age_days * DAY)
    env.transport.history = [tdmsg(CHAT, 100 + i, "%s %d" % (text, i), date=newest - (count - 1 - i) * spacing) for i in range(count)]
    return env.transport.history


def args(**over):
    base = {"chat": CHAT, "dry_run": True, "from_ts": None, "to_id": None, "expect_count": None}
    base.update(over)
    return base


def run(env, **over):
    return run_history(args(**over), env.cfg, env.transport, env.poster, env.log, env.state, env.clock, env.clock.sleep, egress_check=over.pop("egress_check", None) if False else None)


def last(env, event):
    rows = [r for r in env.logs() if r["event"] == event]
    return rows[-1] if rows else None


class Window(unittest.TestCase):
    def session(self, env):
        s = Session(env.transport, env.cfg, None, env.log, env.state, env.clock, env.clock.sleep)
        s.ensure_ready(None)
        return s

    def test_at_most_fifty_messages_even_when_the_channel_has_many_more(self):
        env = Env()
        channel(env, 120)
        messages, pages = read_window(self.session(env), CHAT, env.clock())
        self.assertEqual(len(messages), HISTORY_MAX_MESSAGES)
        self.assertEqual([m["id"] >> 20 for m in messages], list(range(219, 169, -1)))  # exactly the NEWEST 50
        self.assertLessEqual(pages, history.HISTORY_MAX_PAGES)
        env.close()

    def test_the_seven_day_bound_wins_when_it_is_smaller(self):
        env = Env()
        now = int(env.clock())
        env.transport.history = [tdmsg(CHAT, 100 + i, "x %d" % i, date=now - i * 6 * 3600) for i in range(40)][::-1]  # 40 msgs, one per 6 h = 10 days
        messages, _ = read_window(self.session(env), CHAT, now)
        self.assertEqual(len(messages), 29)  # one per 6 h: ages 0..7 days inclusive (a message exactly 7 days old is inside the window), the 11 older ones are not
        self.assertTrue(all(m["date"] >= now - HISTORY_MAX_DAYS * DAY for m in messages))
        env.close()

    def test_every_request_is_inside_the_hard_limits(self):
        env = Env()
        channel(env, 120)
        read_window(self.session(env), CHAT, env.clock())
        self.assertGreater(len(env.transport.history_requests), 0)
        for r in env.transport.history_requests:
            self.assertEqual((r["chat_id"], r["offset"], r["only_local"]), (CHAT, 0, False))
            self.assertTrue(1 <= r["limit"] <= HISTORY_PAGE_LIMIT)
        env.close()

    def test_a_short_first_page_is_followed_up_and_overlapping_pages_are_deduplicated(self):
        env = Env()
        channel(env, 30)
        env.transport.history_first_page_cap = 1  # TDLib often returns fewer messages than asked
        messages, pages = read_window(self.session(env), CHAT, env.clock())
        ids = [m["id"] for m in messages]
        self.assertEqual(len(ids), 30)
        self.assertEqual(len(set(ids)), 30)  # from_message_id is inclusive: the overlap never produces duplicates
        self.assertGreaterEqual(pages, 2)
        env.close()

    def test_an_empty_channel_ends_after_one_request(self):
        env = Env()
        messages, pages = read_window(self.session(env), CHAT, env.clock())
        self.assertEqual((messages, pages), ([], 1))
        env.close()

    def test_the_hard_bounds_cannot_be_widened_by_a_caller(self):
        from twins_capture.tdlib import CaptureError
        env = Env()
        for kwargs in ({"max_messages": 51}, {"max_days": 8}):
            with self.assertRaises(CaptureError):
                read_window(self.session(env), CHAT, env.clock(), **kwargs)
        env.close()

    def test_an_unapproved_chat_cannot_be_read(self):
        from twins_capture.tdlib import CaptureError
        env = Env()
        with self.assertRaises(CaptureError):
            read_window(self.session(env), OTHER_CHAT, env.clock())
        self.assertEqual(env.transport.history_requests, [])
        env.close()


class DryRun(unittest.TestCase):
    def test_reports_counts_ids_and_dates_but_never_contacts_the_endpoint_or_prints_text(self):
        env = Env()
        channel(env, 20, text=POISON)
        env.transport.history.append(dict(tdmsg(CHAT, 500, "", date=int(env.clock()) - 30), content={"@type": "messagePhoto", "caption": {"text": "", "entities": []}}))  # media without a caption
        code = run(env)
        self.assertEqual(code, EXIT_OK)
        self.assertEqual(env.poster.bodies, [])  # no write of any kind
        w = last(env, "history.window")
        self.assertEqual((w["total"], w["with_text"], w["no_text"], w["mode"]), (21, 20, 1, "dry_run"))
        self.assertEqual((w["max_messages"], w["max_days"]), (50, 7))
        self.assertEqual(last(env, "history.ids")["ids"], sorted([100 + i for i in range(20)] + [500]))
        done = last(env, "history.dry_run_done")
        self.assertEqual(done["expect_count"], 20)
        self.assertEqual(done["newest_id"], 500)
        self.assertLessEqual(abs(done["from_ts"] - (int(env.clock()) - 7 * DAY)), 10)  # read time minus exactly seven days
        self.assertNotIn("POISON", env.stream.getvalue())
        self.assertNotIn("9876543210", env.stream.getvalue())
        self.assertTrue(env.transport.closed_delivered)  # TDLib closed gracefully before returning
        env.close()

    def test_edited_messages_are_counted(self):
        env = Env()
        channel(env, 5)
        env.transport.history[2]["edit_date"] = env.transport.history[2]["date"] + 60
        run(env)
        self.assertEqual(last(env, "history.window")["edited"], 1)
        env.close()


class Import(unittest.TestCase):
    def confirmed(self, env):
        run(env)
        done = last(env, "history.dry_run_done")
        return {"dry_run": False, "from_ts": done["from_ts"], "to_id": done["newest_id"], "expect_count": done["expect_count"]}

    def test_imports_exactly_the_confirmed_window_as_api_history_in_one_batch(self):
        env = Env()
        channel(env, 25)
        env.transport.history[3]["edit_date"] = env.transport.history[3]["date"] + 30
        params = self.confirmed(env)
        self.assertEqual(run(env, **params), EXIT_OK)
        self.assertEqual(len(env.poster.bodies), 1)
        body = env.poster.bodies[0]
        self.assertEqual((body["captureMethod"], body["event"], body["schemaVersion"]), ("api_history", "message", 1))
        self.assertEqual(len(body["messages"]), 25)
        batch = body["importBatch"]
        self.assertRegex(batch["batchId"], r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$")
        self.assertEqual(batch["lowestMessageId"], min(m["id"] for m in body["messages"]))
        self.assertEqual(batch["lowestMessageDate"], min(m["date"] for m in body["messages"]))
        self.assertEqual(sum(1 for m in body["messages"] if "editDate" in m), 1)  # an edited message keeps its edit date (revision identity server-side)
        done = last(env, "history.imported")
        self.assertEqual((done["with_text"], done["accepted"], done["duplicates"], done["ignored"], done["batches"]), (25, 25, 0, 0, 1))
        self.assertEqual(done["batch"], batch["batchId"])
        env.close()

    def test_a_window_that_differs_from_the_confirmed_one_aborts_before_any_write(self):
        env = Env()
        channel(env, 25)
        params = self.confirmed(env)
        for change in ({"expect_count": params["expect_count"] + 1}, {"expect_count": params["expect_count"] - 1}):
            env.poster.bodies.clear()
            self.assertEqual(run(env, **dict(params, **change)), EXIT_WINDOW_MISMATCH)
            self.assertEqual(env.poster.bodies, [])
        env.close()

    def test_a_message_that_arrived_after_the_dry_run_is_not_imported(self):
        env = Env()
        channel(env, 25)
        params = self.confirmed(env)
        env.transport.history.append(tdmsg(CHAT, 999, "arrived later", date=int(env.clock()) - 5))
        self.assertEqual(run(env, **params), EXIT_OK)  # to_id keeps the window identical to the confirmed one
        self.assertEqual(len(env.poster.bodies[0]["messages"]), 25)
        self.assertNotIn(999, [m["id"] for m in env.poster.bodies[0]["messages"]])
        env.close()

    def test_the_first_error_or_rate_limit_stops_the_import_and_nothing_is_retried(self):
        for status in (429, 500, 400, 401, 403, 404):
            env = Env(statuses=[status, 202, 202])
            channel(env, 25)
            params = self.confirmed(env)
            self.assertEqual(run(env, **params), EXIT_IMPORT_FAILED, status)
            self.assertEqual(len(env.poster.bodies), 1, status)
            self.assertIn("import_http_%d" % status, [r.get("reason") for r in env.logs()])
            env.close()

    def test_a_transport_error_stops_the_import(self):
        env = Env(statuses=[OSError("down")])
        channel(env, 10)
        params = self.confirmed(env)
        self.assertEqual(run(env, **params), EXIT_IMPORT_FAILED)
        self.assertEqual(len(env.poster.bodies), 1)
        env.close()

    def test_several_batches_share_one_batch_id_and_the_second_failure_stops_the_rest(self):
        env = Env(statuses=[202, 500, 202])
        channel(env, 25)
        params = self.confirmed(env)
        original = history.IMPORT_BATCH_SIZE
        history.IMPORT_BATCH_SIZE = 10
        try:
            self.assertEqual(run(env, **params), EXIT_IMPORT_FAILED)
        finally:
            history.IMPORT_BATCH_SIZE = original
        self.assertEqual(len(env.poster.bodies), 2)  # the third batch was never sent
        self.assertEqual(env.poster.bodies[0]["importBatch"]["batchId"], env.poster.bodies[1]["importBatch"]["batchId"])
        env.close()

    def test_an_empty_window_imports_nothing(self):
        env = Env()
        params = {"dry_run": False, "from_ts": int(env.clock()) - DAY, "to_id": 1, "expect_count": 0}
        self.assertEqual(run(env, **params), EXIT_OK)
        self.assertEqual(env.poster.bodies, [])
        env.close()


class Guards(unittest.TestCase):
    def test_flood_wait_stops_on_the_first_rate_limit_records_it_and_writes_nothing(self):
        env = Env()
        channel(env, 25)
        env.transport.errors["getChatHistory"] = (429, "Too Many Requests: retry after 45")
        self.assertEqual(run(env), EXIT_BLOCKED)
        self.assertEqual(len([r for r in env.transport.sent if r["@type"] == "getChatHistory"]), 1)
        self.assertGreater(env.state.blocked_until(), int(env.clock()))
        self.assertEqual(env.poster.bodies, [])
        self.assertIn("flood_wait", [r.get("reason") for r in env.logs()])
        self.assertTrue(env.transport.closed_delivered)
        env.close()

    def test_a_recorded_block_prevents_any_telegram_contact(self):
        env = Env()
        env.state.set_blocked(500)
        self.assertEqual(run(env), EXIT_BLOCKED)
        self.assertEqual((env.transport.client_ids, env.transport.sent), (0, []))
        env.close()

    def test_a_channel_outside_the_allowlist_is_refused_before_anything_happens(self):
        env = Env()
        self.assertEqual(run(env, chat=OTHER_CHAT), EXIT_CHAT)
        self.assertEqual((env.transport.client_ids, env.transport.sent, env.transport.executed), (0, [], []))
        env.close()

    def test_protected_content_stops_before_any_history_request(self):
        env = Env(protected=True)
        channel(env, 5)
        self.assertEqual(run(env), EXIT_CHAT)
        self.assertEqual(env.transport.history_requests, [])
        env.close()

    def test_no_login_is_ever_attempted_and_an_unauthorized_session_stops(self):
        env = Env(ready=False)
        self.assertEqual(run(env), EXIT_AUTH)
        self.assertFalse({r["@type"] for r in env.transport.sent} & {"setAuthenticationPhoneNumber", "checkAuthenticationCode", "checkAuthenticationPassword"})
        self.assertEqual(env.transport.history_requests, [])
        env.close()

    def test_open_egress_refuses_to_run(self):
        env = Env()
        channel(env, 5)
        code = run_history(args(), env.cfg, env.transport, env.poster, env.log, env.state, env.clock, env.clock.sleep, egress_check=lambda: False)
        self.assertEqual(code, EXIT_EGRESS)
        self.assertEqual((env.transport.client_ids, env.transport.sent), (0, []))
        env.close()

    def test_only_read_requests_are_ever_sent(self):
        env = Env()
        channel(env, 30)
        run(env)
        kinds = {r["@type"] for r in env.transport.sent}
        self.assertEqual(kinds - {"getOption", "setTdlibParameters", "getChat", "getSupergroup", "getChatHistory", "close", "loadChats"}, set())
        env.close()


if __name__ == "__main__":
    unittest.main()
