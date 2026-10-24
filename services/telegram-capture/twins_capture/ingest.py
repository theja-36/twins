"""Delivery to the internal ingest endpoint: bearer token, bounded queue, capped backoff. The API's idempotency makes redelivery safe.
Responses are reduced to a status class; bodies and payloads are never logged."""
import collections
import errno
import http.client
import json
import random
import re
import socket

MAX_BACKOFF_SECONDS = 300
REQUEST_TIMEOUT = 15
MAX_QUEUE = 500
MAX_RETRY_AFTER = 3600
EGRESS_CANARY = ("1.1.1.1", 443)  # a public host that is NOT Telegram: the egress firewall must make it unreachable
EGRESS_PROBE_TIMEOUT = 4


def egress_is_restricted(connect=socket.create_connection, target=EGRESS_CANARY, timeout=EGRESS_PROBE_TIMEOUT):
    """Fail-closed self-test of the Telegram-only egress firewall, run before the client starts. True ONLY when a connection to a non-Telegram
    public host times out or has no route (what the DROP rule produces). A completed connection, a refusal/reset (something answered) or any
    other error is NOT proof of a restriction, so the service refuses to start. This closes the boot-time gap where Docker restarts the
    container before the host's firewall unit has re-applied the rules."""
    try:
        conn = connect(target, timeout=timeout)
    except (socket.timeout, TimeoutError):
        return True
    except OSError as error:
        return error.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH)
    except Exception:
        return False
    try:
        conn.close()
    except Exception:
        pass
    return False


class Backoff(object):
    """1, 2, 4 ... capped at 300 s (5 minutes), with up to 25% jitter. `reset()` after a success."""

    def __init__(self, base=1, cap=MAX_BACKOFF_SECONDS, rng=random.random):
        self._base, self._cap, self._rng, self._n = base, cap, rng, 0

    def next_delay(self):
        raw = min(self._cap, self._base * (2 ** self._n))
        self._n = min(self._n + 1, 30)
        return min(self._cap, int(raw * (1 + 0.25 * self._rng())))

    def reset(self):
        self._n = 0


class IngestFatal(Exception):
    """The endpoint refuses us for a reason retrying cannot fix (wrong token, chat not approved, route absent). Stop and alert."""

    def __init__(self, reason, status):
        Exception.__init__(self, reason)
        self.reason, self.status = reason, status


def _counts(body):
    try:
        data = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    out = {}
    for key in ("accepted", "duplicates", "ignored"):
        value = data.get(key) if isinstance(data, dict) else None
        out[key] = value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    return out


class HttpPoster(object):
    def __init__(self, scheme, host, port, path, token):
        self._scheme, self._host, self._port, self._path, self._token = scheme, host, port, path, token

    def post(self, payload):
        """Returns (status, retry_after_seconds_or_None). Raises OSError/HTTPException on transport failure. No redirects are followed."""
        status, retry_after, _counts_unused = self.post_detail(payload)
        return status, retry_after

    def post_detail(self, payload):
        """Like post(), also returning the API's response counts (or None)."""
        cls = http.client.HTTPSConnection if self._scheme == "https" else http.client.HTTPConnection
        conn = cls(self._host, self._port, timeout=REQUEST_TIMEOUT)
        try:
            body = json.dumps(payload).encode("utf-8")
            conn.request("POST", self._path, body=body, headers={"content-type": "application/json", "authorization": "Bearer " + self._token, "content-length": str(len(body))})
            response = conn.getresponse()
            raw = response.read(65536)
            retry = response.getheader("retry-after")
            retry_after = int(retry) if retry and re.match(r"^[0-9]{1,6}\Z", retry) else None
            return response.status, retry_after, _counts(raw)
        finally:
            conn.close()


def post_detail(poster, payload):
    """One POST for the history import: returns (status, retry_after, counts) where counts is the API's {accepted, duplicates, ignored} (ints
    only, else None). Raises OSError/HTTPException on transport failure. No retry here: the import stops on the first problem."""
    return poster.post_detail(payload)


class Sink(object):
    """Pending events with retry. `submit` never blocks on the network; `pump` delivers what is due."""

    def __init__(self, poster, log, clock, rng=random.random):
        self._poster, self._log, self._clock = poster, log, clock
        self._queue = collections.deque()
        self._backoff = Backoff(rng=rng)
        self._next_try = 0.0
        self.dropped = 0

    def __len__(self):
        return len(self._queue)

    def submit(self, payload, kind):
        if len(self._queue) >= MAX_QUEUE:
            self._queue.popleft()  # oldest first; the gap is recovered by the (separate, approved) history import
            self.dropped += 1
            self._log.log("capture.queue_overflow", level="warn", dropped=self.dropped)
        self._queue.append((payload, kind))

    def pump(self):
        while self._queue and self._clock() >= self._next_try:
            payload, kind = self._queue[0]
            try:
                status, retry_after = self._poster.post(payload)
            except (OSError, http.client.HTTPException):
                self._schedule("transport", None)
                return
            if 200 <= status < 300:
                self._queue.popleft()
                self._backoff.reset()
                self._log.log("capture.delivered", kind=kind, status=status)
            elif status in (401, 403, 404):
                raise IngestFatal({401: "ingest_unauthorized", 403: "ingest_chat_not_approved", 404: "ingest_route_absent"}[status], status)
            elif status == 400:
                self._queue.popleft()  # a payload the API rejects will never be accepted; keep going, never log it
                self._log.log("capture.rejected_payload", level="warn", status=status, kind=kind)
            elif status == 429 or status >= 500:
                self._schedule("http_%d" % status, min(retry_after, MAX_RETRY_AFTER) if retry_after else None)
                return
            else:
                self._queue.popleft()
                self._log.log("capture.unexpected_status", level="warn", status=status, kind=kind)

    def _schedule(self, reason, retry_after):
        delay = retry_after if retry_after else self._backoff.next_delay()
        self._next_try = self._clock() + delay
        self._log.log("capture.delivery_retry", level="warn", reason=reason, delay_s=int(delay), queue=len(self._queue))
