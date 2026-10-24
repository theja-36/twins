"""The supervisor: starts a session, restarts it after transient failures with capped backoff (max 5 minutes), and STOPS (with an alert,
without any automatic retry or re-login) on flood-wait, authorization failure, protected content, an unusable channel, a refusing endpoint or
an unrestricted egress. Under a container restart policy (unless-stopped) a fatal stop must not become a tight restart loop against Telegram:
after the alert and a graceful TDLib close the process HOLDS for FATAL_HOLD_SECONDS (a stop signal ends the hold at once) before exiting."""
from .ingest import Backoff, IngestFatal
from .session import AuthFailure, ChatUnavailable, Recoverable, Session, check_session_dir
from .tdlib import CaptureError, FloodWait, LOG_STREAM_EMPTY, verify_library

EXIT_OK = 0
EXIT_BLOCKED = 75      # flood-wait: blocked_until recorded, do not run again before then
EXIT_AUTH = 76         # authorization failure: the owner must log in again (login mode)
EXIT_CHAT = 77         # channel unusable (not found / not a member / protected content)
EXIT_INGEST = 78       # the internal endpoint refuses us
EXIT_EGRESS = 79       # the Telegram-only egress restriction is not in force (fail-closed self-test)
EXIT_CONFIG = 2
HEALTHY_AFTER_SECONDS = 60
FATAL_HOLD_SECONDS = 900  # 15 minutes: bounds how often a restarted container can re-contact Telegram after a fatal condition


def prepare_transport(transport, log):
    transport.execute({"@type": "setLogVerbosityLevel", "new_verbosity_level": 0})
    transport.execute({"@type": "setLogStream", "log_stream": LOG_STREAM_EMPTY})
    version, commit = verify_library(transport)
    log.log("capture.library_verified", version=version[:20])
    return version, commit


def _hold(seconds, clock, sleep, should_stop):
    end = clock() + seconds
    while not should_stop() and clock() < end:
        sleep(1.0)


def run_service(cfg, transport, sink, log, state, clock, sleep, should_stop, backoff=None, egress_check=None):
    blocked = state.blocked_until()
    if clock() < blocked:
        log.alert("flood_block_active", blocked_until=int(blocked))
        _hold(FATAL_HOLD_SECONDS, clock, sleep, should_stop)
        return EXIT_BLOCKED
    if egress_check is not None and not egress_check():
        state.record_alert("egress_unrestricted")
        log.alert("egress_unrestricted")
        _hold(FATAL_HOLD_SECONDS, clock, sleep, should_stop)
        return EXIT_EGRESS
    check_session_dir(cfg.session_dir)
    prepare_transport(transport, log)
    backoff = backoff or Backoff()
    attempt = 0
    while not should_stop():
        session = Session(transport, cfg, sink, log, state, clock, sleep)
        started = clock()
        fatal = None
        clean = False
        try:
            session.ensure_ready(None)
            session.resolve_chats()
            log.log("capture.started", count=len(cfg.chat_ids))
            session.run(should_stop)
            clean = True
        except FloodWait as error:
            until = state.set_blocked(error.seconds)
            log.alert("flood_wait", blocked_until=until, delay_s=min(int(error.seconds), 10 ** 6))
            state.record_alert("flood_wait")
            fatal = EXIT_BLOCKED
        except AuthFailure as error:
            state.record_alert(error.reason)
            log.alert(error.reason)
            fatal = EXIT_AUTH
        except ChatUnavailable as error:
            state.record_alert(error.reason)
            log.alert(error.reason)
            fatal = EXIT_CHAT
        except IngestFatal as error:
            state.record_alert(error.reason)
            log.alert(error.reason, status=error.status)
            fatal = EXIT_INGEST
        except CaptureError as error:  # Recoverable, or an unexpected Telegram error code: restart with capped backoff, never faster
            if clock() - started >= HEALTHY_AFTER_SECONDS:
                backoff.reset()
            attempt += 1
            delay = backoff.next_delay()
            log.log("capture.session_restart", level="warn", reason="recoverable" if isinstance(error, Recoverable) else "error", error_code=error.code if isinstance(error.code, int) else 0, attempt=attempt, delay_s=delay)
            sleep(delay)
        finally:
            session.close()  # TDLib is closed FIRST (waits for its Closed state), only then may the process hold or exit
        if fatal is not None:
            _hold(FATAL_HOLD_SECONDS, clock, sleep, should_stop)
            return fatal
        if clean:
            return EXIT_OK
    return EXIT_OK
