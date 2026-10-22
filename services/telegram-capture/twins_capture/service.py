"""The supervisor: starts a session, restarts it after transient failures with capped backoff (max 5 minutes), and STOPS (with an alert,
without any automatic retry or re-login) on flood-wait, authorization failure, protected content, an unusable channel or a refusing endpoint."""
from .ingest import Backoff, IngestFatal
from .session import AuthFailure, ChatUnavailable, Recoverable, Session, check_session_dir
from .tdlib import CaptureError, FloodWait, LOG_STREAM_EMPTY, verify_library

EXIT_OK = 0
EXIT_BLOCKED = 75      # flood-wait: blocked_until recorded, do not run again before then
EXIT_AUTH = 76         # authorization failure: the owner must log in again (login mode)
EXIT_CHAT = 77         # channel unusable (not found / not a member / protected content)
EXIT_INGEST = 78       # the internal endpoint refuses us
EXIT_CONFIG = 2
HEALTHY_AFTER_SECONDS = 60


def prepare_transport(transport, log):
    transport.execute({"@type": "setLogVerbosityLevel", "new_verbosity_level": 0})
    transport.execute({"@type": "setLogStream", "log_stream": LOG_STREAM_EMPTY})
    version, commit = verify_library(transport)
    log.log("capture.library_verified", version=version[:20])
    return version, commit


def run_service(cfg, transport, sink, log, state, clock, sleep, should_stop, backoff=None):
    blocked = state.blocked_until()
    if clock() < blocked:
        log.alert("flood_block_active", blocked_until=int(blocked))
        return EXIT_BLOCKED
    check_session_dir(cfg.session_dir)
    prepare_transport(transport, log)
    backoff = backoff or Backoff()
    attempt = 0
    while not should_stop():
        session = Session(transport, cfg, sink, log, state, clock, sleep)
        started = clock()
        try:
            session.ensure_ready(None)
            session.resolve_chats()
            log.log("capture.started", count=len(cfg.chat_ids))
            session.run(should_stop)
        except FloodWait as error:
            until = state.set_blocked(error.seconds)
            log.alert("flood_wait", blocked_until=until, delay_s=min(int(error.seconds), 10 ** 6))
            state.record_alert("flood_wait")
            return EXIT_BLOCKED
        except AuthFailure as error:
            state.record_alert(error.reason)
            log.alert(error.reason)
            return EXIT_AUTH
        except ChatUnavailable as error:
            state.record_alert(error.reason)
            log.alert(error.reason)
            return EXIT_CHAT
        except IngestFatal as error:
            state.record_alert(error.reason)
            log.alert(error.reason, status=error.status)
            return EXIT_INGEST
        except CaptureError as error:  # Recoverable, or an unexpected Telegram error code: restart with capped backoff, never faster
            if clock() - started >= HEALTHY_AFTER_SECONDS:
                backoff.reset()
            attempt += 1
            delay = backoff.next_delay()
            log.log("capture.session_restart", level="warn", reason="recoverable" if isinstance(error, Recoverable) else "error", error_code=error.code if isinstance(error.code, int) else 0, attempt=attempt, delay_s=delay)
            sleep(delay)
        else:
            return EXIT_OK
        finally:
            session.close()
    return EXIT_OK
