import http.server
import json
import os
import threading
import unittest

from fakes import CHAT, TOKEN, Env, tdmsg
from twins_capture.ingest import Backoff, HttpPoster, IngestFatal, MAX_BACKOFF_SECONDS, MAX_QUEUE, Sink
from twins_capture.service import EXIT_AUTH, EXIT_BLOCKED, EXIT_CHAT, EXIT_INGEST, EXIT_OK, run_service
from twins_capture.tdlib import CaptureError


def service(env, stop_after=5, backoff=None, sleep=None):
    end = env.clock() + stop_after
    calls = {"n": 0}

    def should_stop():
        calls["n"] += 1  # a supervisor that spins without waiting (e.g. retrying a flood-wait) is cut off and fails the assertions instead of hanging
        return env.clock() >= end or calls["n"] > 2000

    return run_service(env.cfg, env.transport, env.sink, env.log, env.state, env.clock, sleep or env.clock.sleep, should_stop, backoff=backoff)


class BackoffRules(unittest.TestCase):
    def test_doubles_and_is_capped_at_five_minutes(self):
        b = Backoff(rng=lambda: 0.0)
        delays = [b.next_delay() for _ in range(15)]
        self.assertEqual(delays[:5], [1, 2, 4, 8, 16])
        self.assertEqual(max(delays), MAX_BACKOFF_SECONDS)
        self.assertEqual(MAX_BACKOFF_SECONDS, 300)
        self.assertEqual(delays[-1], 300)

    def test_jitter_never_exceeds_the_cap_and_reset_restarts(self):
        b = Backoff(rng=lambda: 1.0)
        self.assertLessEqual(max(b.next_delay() for _ in range(40)), 300)
        b.reset()
        self.assertLessEqual(b.next_delay(), 2)


class SupervisorStops(unittest.TestCase):
    def test_flood_wait_stops_records_blocked_until_and_does_not_retry(self):
        env = Env()
        env.transport.errors["getChat"] = (429, "Too Many Requests: retry after 120")
        self.assertEqual(service(env), EXIT_BLOCKED)
        self.assertEqual(len([r for r in env.transport.sent if r["@type"] == "getChat"]), 1)
        # blocked_until = (time of the error) + 120 s + 60 s margin; the graceful close afterwards advances the fake clock a little
        self.assertTrue(0 <= (env.clock() - (env.state.blocked_until() - 180)) <= 20, env.state.blocked_until())
        self.assertEqual(env.transport.client_ids, 1)  # no second client
        alerts = [r for r in env.logs() if r["event"] == "capture.alert"]
        self.assertEqual(alerts[0]["reason"], "flood_wait")
        env.close()

    def test_a_recorded_block_prevents_starting_at_all(self):
        env = Env()
        env.state.set_blocked(500)
        self.assertEqual(service(env), EXIT_BLOCKED)
        self.assertEqual(env.transport.client_ids, 0)
        self.assertEqual(env.transport.sent, [])
        env.clock.now += 1000  # after the block expired the service may start again
        self.assertEqual(service(env, stop_after=2), EXIT_OK)
        env.close()

    def test_authorization_failure_stops_alerts_and_never_logs_in(self):
        env = Env(ready=False)
        self.assertEqual(service(env), EXIT_AUTH)
        self.assertEqual(env.transport.client_ids, 1)
        self.assertFalse({r["@type"] for r in env.transport.sent} & {"setAuthenticationPhoneNumber", "checkAuthenticationCode", "checkAuthenticationPassword"})
        with open(os.path.join(env.state_dir, "alert.json")) as handle:
            self.assertEqual(json.load(handle)["reason"], "login_required")
        env.close()

    def test_revocation_while_running_stops_with_auth_exit(self):
        env = Env()
        env.transport.inbox.append({"@type": "updateAuthorizationState", "authorization_state": {"@type": "authorizationStateClosed"}})
        self.assertEqual(service(env, stop_after=30), EXIT_AUTH)
        self.assertEqual(env.transport.client_ids, 1)
        env.close()

    def test_protected_content_and_unusable_channel_stop_with_alert(self):
        for kwargs in ({"protected": True}, {"member": "chatMemberStatusBanned"}):
            env = Env(**kwargs)
            self.assertEqual(service(env), EXIT_CHAT)
            self.assertEqual(env.transport.client_ids, 1)
            env.close()

    def test_refusing_endpoint_stops_with_alert(self):
        for status, reason in ((401, "ingest_unauthorized"), (403, "ingest_chat_not_approved"), (404, "ingest_route_absent")):
            env = Env(statuses=[status])
            env.transport.inbox.append({"@type": "updateNewMessage", "message": tdmsg(CHAT, 5, "hi")})
            self.assertEqual(service(env), EXIT_INGEST)
            self.assertIn(reason, [r.get("reason") for r in env.logs()])
            env.close()

    def test_old_or_unpinned_library_refuses_to_start(self):
        env = Env(commit="1" * 40)
        with self.assertRaises(CaptureError):
            service(env)
        self.assertEqual(env.transport.client_ids, 0)
        env.close()

    def test_transient_failure_restarts_with_growing_capped_delays_not_in_a_tight_loop(self):
        env = Env()
        env.transport.errors["getChat"] = (500, "Internal")
        slept = []
        original = env.clock.sleep
        self.assertEqual(service(env, stop_after=3000, backoff=Backoff(rng=lambda: 0.0), sleep=lambda sec: (slept.append(sec), original(sec))[1]), EXIT_OK)
        delays = [s for s in slept if s >= 1 and s == int(s) and s in (1, 2, 4, 8, 16, 32, 64, 128, 256, 300)]
        self.assertGreaterEqual(len(delays), 8)
        self.assertEqual(delays[:8], [1, 2, 4, 8, 16, 32, 64, 128])
        self.assertLessEqual(max(slept), 300)
        self.assertGreater(env.transport.client_ids, 3)
        env.close()


class SinkRules(unittest.TestCase):
    def sink(self, statuses):
        env = Env(statuses=statuses)
        return env, env.sink

    def test_delivered_on_2xx(self):
        env, sink = self.sink([202])
        sink.submit({"a": 1}, "message")
        sink.pump()
        self.assertEqual((len(sink), len(env.poster.bodies)), (0, 1))
        env.close()

    def test_5xx_and_transport_errors_retry_with_backoff_and_lose_nothing(self):
        env, sink = self.sink([500, OSError("down"), 202])
        sink.submit({"a": 1}, "message")
        sink.pump()
        self.assertEqual(len(sink), 1)
        sink.pump()  # not yet due: no extra request
        self.assertEqual(len(env.poster.bodies), 1)
        env.clock.now += 1
        sink.pump()
        self.assertEqual(len(env.poster.bodies), 2)
        env.clock.now += 2
        sink.pump()
        self.assertEqual((len(sink), len(env.poster.bodies)), (0, 3))
        env.close()

    def test_429_honours_retry_after(self):
        env, sink = self.sink([(429, 50), 202])
        sink.submit({"a": 1}, "message")
        sink.pump()
        env.clock.now += 49
        sink.pump()
        self.assertEqual(len(env.poster.bodies), 1)
        env.clock.now += 2
        sink.pump()
        self.assertEqual(len(sink), 0)
        env.close()

    def test_400_drops_the_payload_and_continues(self):
        env, sink = self.sink([400, 202])
        sink.submit({"bad": 1}, "message")
        sink.submit({"good": 1}, "message")
        sink.pump()
        self.assertEqual([b for b in env.poster.bodies], [{"bad": 1}, {"good": 1}])
        self.assertEqual(len(sink), 0)
        env.close()

    def test_fatal_statuses_raise(self):
        for status in (401, 403, 404):
            env, sink = self.sink([status])
            sink.submit({"a": 1}, "message")
            with self.assertRaises(IngestFatal):
                sink.pump()
            env.close()

    def test_queue_is_bounded_and_drops_the_oldest(self):
        env, sink = self.sink([500] * 3)
        for i in range(MAX_QUEUE + 5):
            sink.submit({"i": i}, "message")
        self.assertEqual((len(sink), sink.dropped), (MAX_QUEUE, 5))
        env.close()

    def test_order_is_preserved(self):
        env, sink = self.sink([202, 202, 202])
        for i in range(3):
            sink.submit({"i": i}, "message")
        sink.pump()
        self.assertEqual([b["i"] for b in env.poster.bodies], [0, 1, 2])
        env.close()


class Handler(http.server.BaseHTTPRequestHandler):
    seen = []
    status = 202

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        Handler.seen.append((self.path, self.headers.get("authorization"), self.headers.get("content-type"), json.loads(body)))
        self.send_response(Handler.status)
        if Handler.status == 302:
            self.send_header("location", "http://127.0.0.1:1/elsewhere")
        if Handler.status == 429:
            self.send_header("retry-after", "7")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class RealHttp(unittest.TestCase):
    def setUp(self):
        Handler.seen, Handler.status = [], 202
        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.poster = HttpPoster("http", "127.0.0.1", self.server.server_address[1], "/internal/ingest/telegram-user", TOKEN)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_post_sends_bearer_token_json_and_the_exact_path(self):
        self.assertEqual(self.poster.post({"x": 1}), (202, None))
        path, auth, ctype, body = Handler.seen[0]
        self.assertEqual((path, auth, ctype, body), ("/internal/ingest/telegram-user", "Bearer " + TOKEN, "application/json", {"x": 1}))

    def test_retry_after_is_read_and_redirects_are_not_followed(self):
        Handler.status = 429
        self.assertEqual(self.poster.post({}), (429, 7))
        Handler.status = 302
        self.assertEqual(self.poster.post({})[0], 302)
        self.assertEqual(len(Handler.seen), 2)  # the Location was never requested


if __name__ == "__main__":
    unittest.main()


class GracefulShutdown(unittest.TestCase):
    """TDLib `close` only STARTS closing. The process must not exit before authorizationStateClosed (the intermittent SIGABRT / exit 134)."""

    def test_close_waits_for_the_closed_state_before_returning(self):
        from twins_capture.session import Session
        env = Env()
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        session.ensure_ready(None)
        self.assertFalse(env.transport.closed_delivered)
        self.assertTrue(session.close())
        self.assertTrue(env.transport.closed_delivered)  # returned only AFTER Closed was received
        self.assertEqual(session.auth_state, "authorizationStateClosed")
        self.assertGreater(env.transport.close_polls, env.transport.close_delay_polls)  # it really kept receiving
        self.assertIn("capture.closed", [r["event"] for r in env.logs()])
        env.close()

    def test_close_is_bounded_when_telegram_never_reports_closed(self):
        from twins_capture.session import CLOSE_REQUEST_TIMEOUT, CLOSE_WAIT_TIMEOUT, Session
        env = Env()
        env.transport.never_close = True
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        session.ensure_ready(None)
        before = env.clock()
        self.assertFalse(session.close())
        self.assertLessEqual(env.clock() - before, CLOSE_REQUEST_TIMEOUT + CLOSE_WAIT_TIMEOUT + 2)
        self.assertLess(CLOSE_REQUEST_TIMEOUT + CLOSE_WAIT_TIMEOUT, 30)  # inside the container's 30 s stop grace period
        self.assertIn("capture.close_timeout", [r["event"] for r in env.logs()])
        env.close()

    def test_an_already_closed_client_is_not_asked_again(self):
        from twins_capture.session import Session
        env = Env()
        session = Session(env.transport, env.cfg, env.sink, env.log, env.state, env.clock, env.clock.sleep)
        session.ensure_ready(None)
        session.close()
        sent = len(env.transport.sent)
        self.assertTrue(session.close())
        self.assertEqual(len(env.transport.sent), sent)
        env.close()

    def test_a_stop_signal_ends_the_service_with_exit_code_0_only_after_tdlib_closed(self):
        env = Env()
        calls = {"n": 0}

        def should_stop():
            calls["n"] += 1
            return calls["n"] > 3  # the SIGTERM flag flips while the service is running

        code = run_service(env.cfg, env.transport, env.sink, env.log, env.state, env.clock, env.clock.sleep, should_stop)
        self.assertEqual(code, EXIT_OK)
        self.assertTrue(env.transport.closed_delivered)  # run_service returns (the process may exit) only after Closed
        env.close()

    def test_fatal_stops_also_wait_for_the_closed_state(self):
        env = Env(ready=False)  # authorization failure path
        code = run_service(env.cfg, env.transport, env.sink, env.log, env.state, env.clock, env.clock.sleep, lambda: False)
        self.assertEqual(code, EXIT_AUTH)
        self.assertTrue(env.transport.closed_delivered)
        env.close()
