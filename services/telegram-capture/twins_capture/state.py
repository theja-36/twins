"""Small private state: blocked_until (flood-wait) and the last alert. Files are 0600 in a 0700 directory (not in any backup path)."""
import json
import os
import stat
import tempfile
import time


class StateError(Exception):
    pass


class State(object):
    def __init__(self, directory, clock=time.time):
        self._dir, self._clock = directory, clock

    def _ensure_dir(self):
        os.makedirs(self._dir, mode=0o700, exist_ok=True)
        info = os.lstat(self._dir)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077:
            raise StateError("state directory must be a private (0700) directory, not a link")

    def _write(self, name, data):
        self._ensure_dir()
        fd, tmp = tempfile.mkstemp(dir=self._dir, prefix=".tmp-")
        with os.fdopen(fd, "w") as handle:
            json.dump(data, handle, sort_keys=True)
        os.chmod(tmp, 0o600)
        os.replace(tmp, os.path.join(self._dir, name))

    def _read(self, name):
        try:
            with open(os.path.join(self._dir, name), "r") as handle:
                value = json.load(handle)
            return value if isinstance(value, dict) else {}
        except (OSError, ValueError):
            return {}

    def blocked_until(self):
        value = self._read("blocked.json").get("blocked_until")
        return value if isinstance(value, int) and not isinstance(value, bool) else 0

    def set_blocked(self, seconds):
        until = int(self._clock()) + int(seconds) + 60  # a minute of margin
        self._write("blocked.json", {"blocked_until": until})
        return until

    def record_alert(self, reason):
        self._write("alert.json", {"reason": reason, "ts": int(self._clock())})

    def protected_content(self):
        return self._read("chat.json").get("protected_content")

    def set_protected_content(self, value):
        self._write("chat.json", {"protected_content": bool(value)})
