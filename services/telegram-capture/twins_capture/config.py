"""Configuration, read ONLY from environment variables. Nothing is hardcoded and no value is ever echoed in an error message."""
import base64
import ipaddress
import re
import urllib.parse

_API_HASH = re.compile(r"^[0-9a-f]{32}\Z")
_DB_KEY = re.compile(r"^[0-9a-f]{64}\Z")
_CHAT_ID = re.compile(r"^-100[0-9]{9,13}\Z")
_TOKEN = re.compile(r"^[A-Za-z0-9_+=.~-]{32,256}\Z")
_HOST_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\Z")

DEFAULT_SESSION_DIR = "/var/lib/twins-capture/tdlib-db"
DEFAULT_STATE_DIR = "/var/lib/twins-capture/state"
DEFAULT_TDJSON = "/opt/tdlib/libtdjson.so"


class ConfigError(Exception):
    """Names the offending variable and the rule, never the value."""


def _need(env, name):
    value = env.get(name)
    if value is None or value == "":
        raise ConfigError("%s is not set" % name)
    return value


def parse_chat_ids(text):
    ids = []
    for part in text.split(","):
        part = part.strip()
        if not _CHAT_ID.match(part):
            raise ConfigError("TWINS_TELEGRAM_ALLOWED_CHAT_IDS must be comma-separated -100... channel ids (digits only; no names or wildcards)")
        ids.append(int(part))
    if not ids or len(set(ids)) != len(ids) or len(ids) > 5:
        raise ConfigError("TWINS_TELEGRAM_ALLOWED_CHAT_IDS must list 1-5 distinct channel ids")
    return frozenset(ids)


def validate_ingest_url(url):
    """The ingest endpoint is INTERNAL only: a single-label service name, localhost or a private/loopback address. Never a public host."""
    try:
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        port = parsed.port
    except ValueError:
        raise ConfigError("TWINS_CAPTURE_INGEST_URL is not a valid URL")
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigError("TWINS_CAPTURE_INGEST_URL must be http(s) with no credentials, query or fragment")
    if parsed.path not in ("", "/internal/ingest/telegram-user"):
        raise ConfigError("TWINS_CAPTURE_INGEST_URL path must be empty or /internal/ingest/telegram-user")
    internal = False
    try:
        address = ipaddress.ip_address(host)
        internal = address.is_loopback or address.is_private
    except ValueError:
        internal = host == "localhost" or bool(_HOST_LABEL.match(host))  # a bare service name such as `api`; dotted names are public DNS
    if not internal:
        raise ConfigError("TWINS_CAPTURE_INGEST_URL must point to an internal host (service name, localhost or a private address)")
    return parsed.scheme, host, port, "/internal/ingest/telegram-user"


class Config(object):
    __slots__ = ("api_id", "api_hash", "db_key_b64", "chat_ids", "token", "ingest", "session_dir", "state_dir", "tdjson")

    def __repr__(self):  # secrets must never reach a log by accident
        return "Config(<redacted>)"


def load_config(env):
    cfg = Config()
    api_id = _need(env, "TWINS_TELEGRAM_API_ID")
    if not api_id.isdigit() or not 1 <= len(api_id) <= 12:
        raise ConfigError("TWINS_TELEGRAM_API_ID has an unexpected format")
    cfg.api_id = int(api_id)
    api_hash = _need(env, "TWINS_TELEGRAM_API_HASH")
    if not _API_HASH.match(api_hash):
        raise ConfigError("TWINS_TELEGRAM_API_HASH has an unexpected format")
    cfg.api_hash = api_hash
    key = _need(env, "TWINS_TELEGRAM_SESSION_DB_KEY")
    if not _DB_KEY.match(key):
        raise ConfigError("TWINS_TELEGRAM_SESSION_DB_KEY must be 64 hex characters")
    cfg.db_key_b64 = base64.b64encode(bytes.fromhex(key)).decode("ascii")
    cfg.chat_ids = parse_chat_ids(_need(env, "TWINS_TELEGRAM_ALLOWED_CHAT_IDS"))
    token = _need(env, "TWINS_CAPTURE_INGEST_TOKEN")
    if not _TOKEN.match(token):
        raise ConfigError("TWINS_CAPTURE_INGEST_TOKEN must be 32-256 characters of A-Za-z0-9_-+=.~")
    cfg.token = token
    cfg.ingest = validate_ingest_url(_need(env, "TWINS_CAPTURE_INGEST_URL"))
    cfg.session_dir = env.get("TWINS_TELEGRAM_SESSION_DIR") or DEFAULT_SESSION_DIR
    cfg.state_dir = env.get("TWINS_CAPTURE_STATE_DIR") or DEFAULT_STATE_DIR
    cfg.tdjson = env.get("TWINS_TDJSON") or DEFAULT_TDJSON
    return cfg
