"""The ONLY output channel. A record is an event name plus whitelisted, content-free fields. Anything else is refused, so message
text, titles, names, phone numbers, codes, the api_hash and tokens cannot reach a log, however a caller is written."""
import json
import re
import sys
import time

_EVENT = re.compile(r"^[a-z][a-z0-9_.]{2,48}\Z")
_SAFE_STR = re.compile(r"^[A-Za-z0-9_.:-]{0,64}\Z")
# field name -> kind. Strings must be short identifiers (enum-like); integers are counts, ids and codes.
ALLOWED_FIELDS = {
    "reason": "str", "state": "str", "kind": "str", "error_code": "int", "count": "int", "attempt": "int", "delay_s": "int",
    "chat_id": "int", "message_id": "int", "status": "int", "blocked_until": "int", "queue": "int", "dropped": "int",
    "version": "str", "tdlib_state": "str", "method": "str", "exit": "int", "rule": "str",
    # history pilot report: counts, ids and times only
    "total": "int", "with_text": "int", "no_text": "int", "edited": "int", "oldest_id": "int", "newest_id": "int", "oldest_ts": "int",
    "newest_ts": "int", "from_ts": "int", "pages": "int", "accepted": "int", "duplicates": "int", "ignored": "int", "batches": "int",
    "expect_count": "int", "max_messages": "int", "max_days": "int", "batch": "str", "mode": "str", "ids": "ints",
}


class SafeLogger(object):
    def __init__(self, stream=None, clock=time.time):
        self._stream = stream if stream is not None else sys.stdout
        self._clock = clock

    def log(self, event, level="info", **fields):
        if not _EVENT.match(event or ""):
            raise ValueError("bad event name")
        record = {"ts": int(self._clock()), "level": level, "event": event}
        for name, value in fields.items():
            kind = ALLOWED_FIELDS.get(name)
            if kind is None:
                raise ValueError("log field not allowed: %s" % name)
            if kind == "ints":
                if not isinstance(value, list) or len(value) > 200 or any(isinstance(v, bool) or not isinstance(v, int) for v in value):
                    raise ValueError("log field %s must be a short list of integers" % name)
            elif kind == "int":
                if isinstance(value, bool) or not isinstance(value, int):
                    raise ValueError("log field %s must be an integer" % name)
            elif not isinstance(value, str) or not _SAFE_STR.match(value):
                raise ValueError("log field %s must be a short identifier" % name)
            record[name] = value
        self._stream.write(json.dumps(record, sort_keys=True) + "\n")
        self._stream.flush()

    def alert(self, reason, **fields):
        self.log("capture.alert", level="error", reason=reason, **fields)
