#!/usr/bin/env python3
"""TWINS Telegram user-capture client. Commands (exactly these):
  run           the service: read-only capture of the approved channel(s) -> internal ingest endpoint. Never logs in, never prompts.
  login         one-time, interactive (the OWNER, in their own terminal): creates the encrypted session. Prompts for phone, code, password.
  logout        invalidates the session on Telegram's side and deletes the local TDLib database.
  check-config  validates the environment only (prints which rule failed, never a value). No Telegram, no network.
  history       read-only, bounded history pilot: `history --chat <id> --dry-run`, then `history --chat <id> --import --from-ts T --to-id N --expect-count K`.
Everything is configured through environment variables (see twins_capture/config.py). Run as: python3 -E -s -B main.py <command>"""
import argparse
import getpass
import os
import shutil
import signal
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from twins_capture.config import ConfigError, load_config  # noqa: E402
from twins_capture.history import run_history  # noqa: E402
from twins_capture.liveguard import enforce_live_trading_guard  # noqa: E402
from twins_capture.ingest import HttpPoster, Sink, egress_is_restricted  # noqa: E402
from twins_capture.safelog import SafeLogger  # noqa: E402
from twins_capture.service import EXIT_AUTH, EXIT_CONFIG, EXIT_OK, prepare_transport, run_service  # noqa: E402
from twins_capture.session import Session, check_session_dir  # noqa: E402
from twins_capture.state import State  # noqa: E402
from twins_capture.tdlib import CaptureError, FloodWait, TdTransport  # noqa: E402


class TerminalIO(object):
    def prompt_phone(self):
        return input("Phone number in international format (e.g. +91...): ").strip()

    def prompt_code(self):
        return getpass.getpass("Login code shown in your Telegram app (input hidden): ").strip()

    def prompt_password(self):
        return getpass.getpass("Two-step verification password (input hidden): ")


def history_main(argv, env, log):
    parser = argparse.ArgumentParser(prog="main.py history", description="Read-only, bounded history pilot (50 messages or 7 days, whichever is smaller).")
    parser.add_argument("--chat", type=int, required=True, help="the approved channel id (must be in TWINS_TELEGRAM_ALLOWED_CHAT_IDS)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="read from Telegram and report counts only; never contacts the ingest endpoint")
    mode.add_argument("--import", dest="do_import", action="store_true", help="import the window confirmed by a dry-run (needs the three parameters below)")
    parser.add_argument("--from-ts", type=int, help="import only: lower date bound printed by the dry-run")
    parser.add_argument("--to-id", type=int, help="import only: newest message id printed by the dry-run")
    parser.add_argument("--expect-count", type=int, help="import only: number of importable messages confirmed by the dry-run")
    args = parser.parse_args(argv)
    given = [args.from_ts, args.to_id, args.expect_count]
    if args.do_import and any(v is None for v in given):
        parser.error("--import needs --from-ts, --to-id and --expect-count from a confirmed dry-run")
    if args.dry_run and any(v is not None for v in given):
        parser.error("--dry-run takes no window parameters")
    try:
        cfg = load_config(env)
    except ConfigError as error:
        sys.stderr.write("configuration error: %s\n" % error)
        return EXIT_CONFIG
    try:
        transport = TdTransport(cfg.tdjson)
        poster = HttpPoster(cfg.ingest[0], cfg.ingest[1], cfg.ingest[2], cfg.ingest[3], cfg.token)
        return run_history({"chat": args.chat, "dry_run": args.dry_run, "from_ts": args.from_ts, "to_id": args.to_id, "expect_count": args.expect_count},
                           cfg, transport, poster, log, State(cfg.state_dir), time.time, time.sleep, egress_check=egress_is_restricted)
    except CaptureError as error:
        log.alert(getattr(error, "reason", "error"))
        return EXIT_AUTH


def main(argv, env):
    enforce_live_trading_guard("capture", env)  # first statement of every command, before configuration is even read
    log = SafeLogger()
    if argv and argv[0] == "history":
        return history_main(argv[1:], env, log)
    command = argv[0] if len(argv) == 1 else None
    if command not in ("run", "login", "logout", "check-config"):
        sys.stderr.write("usage: main.py run|login|logout|check-config\n")
        return EXIT_CONFIG
    try:
        cfg = load_config(env)
    except ConfigError as error:
        sys.stderr.write("configuration error: %s\n" % error)
        return EXIT_CONFIG
    if command == "check-config":
        log.log("capture.config_ok", count=len(cfg.chat_ids))
        return EXIT_OK
    state = State(cfg.state_dir)
    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("flag", True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__("flag", True))
    try:
        transport = TdTransport(cfg.tdjson)
        sink = Sink(HttpPoster(cfg.ingest[0], cfg.ingest[1], cfg.ingest[2], cfg.ingest[3], cfg.token), log, time.time)
        if command == "run":
            return run_service(cfg, transport, sink, log, state, time.time, time.sleep, lambda: stop["flag"], egress_check=egress_is_restricted)
        check_session_dir(cfg.session_dir)
        prepare_transport(transport, log)
        session = Session(transport, cfg, sink, log, state, time.time, time.sleep)
        try:
            session.ensure_ready(TerminalIO() if command == "login" else None)
            if command == "login":
                session.resolve_chats()
                log.log("capture.login_ok", count=len(cfg.chat_ids))
            else:
                session.request("logOut")
                real = os.path.realpath(cfg.session_dir)
                if os.path.basename(real) and os.path.exists(real):
                    shutil.rmtree(real)
                log.log("capture.logged_out")
        finally:
            session.close()
        return EXIT_OK
    except FloodWait as error:
        state.set_blocked(error.seconds)
        log.alert("flood_wait")
        return 75
    except CaptureError as error:
        log.alert(getattr(error, "reason", "error"))
        return EXIT_AUTH


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], os.environ))
