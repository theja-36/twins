import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateIngestBody } from "../../../apps/api/src/internalIngestValidation";

/**
 * Static safety checks for the Telegram user-capture client (services/telegram-capture) and a runner for its Python unit tests.
 * No Telegram, no native TDLib, no external network: the Python tests use a scripted fake transport and a loopback HTTP server.
 */
const DIR = "services/telegram-capture";
const MODULES = ["config", "safelog", "tdlib", "mapping", "ingest", "state", "session", "service"].map((m) => `${DIR}/twins_capture/${m}.py`);
const MAIN = `${DIR}/main.py`;
const sources = Object.fromEntries([...MODULES, MAIN].map((f) => [f, readFileSync(f, "utf8")])) as Record<string, string>;
const all = Object.values(sources).join("\n");
const tdlib = sources[`${DIR}/twins_capture/tdlib.py`] ?? "";

/** The exact TDLib request types the client may send (reviewed). Changing this list is a reviewed change. */
const EXPECTED_REQUESTS = [
  "checkAuthenticationCode", "checkAuthenticationPassword", "close", "getChat", "getMessage", "getOption", "getSupergroup",
  "loadChats", "logOut", "setAuthenticationPhoneNumber", "setLogStream", "setLogVerbosityLevel", "setTdlibParameters",
].sort();
const NESTED_TYPES = ["chatListArchive", "chatListMain", "logStreamEmpty"];
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const matches = (rx: RegExp, text: string) => [...text.matchAll(rx)].map((m) => m[1] as string);

describe("capture client: exact TDLib request allowlist", () => {
  it("ALLOWED_REQUESTS in the source is exactly the reviewed list", () => {
    const block = /ALLOWED_REQUESTS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/.exec(tdlib)?.[1] ?? "";
    expect(sorted(matches(/"([A-Za-z]+)"/g, block))).toEqual(EXPECTED_REQUESTS);
  });
  it("every request the code can send is on the list, and every listed request is used", () => {
    const used = sorted([
      ...matches(/\.request\(\s*"([A-Za-z]+)"/g, all).filter((x) => x !== "POST"), // `conn.request("POST", ...)` is the HTTP method, not TDLib
      ...matches(/\breq\([^"\n]*"([A-Za-z]+)"/g, all),
      ...matches(/\{"@type":\s*"([A-Za-z]+)"/g, all),
      ...matches(/"((?:set|check)Authentication[A-Za-z]*)"/g, sources[`${DIR}/twins_capture/session.py`] ?? ""),
    ].filter((x) => !NESTED_TYPES.includes(x)));
    expect(used).toEqual(EXPECTED_REQUESTS);
  });
  it("only allowed '@type' literals appear in dictionary literals", () => {
    for (const literal of sorted(matches(/"@type"\s*:\s*"([A-Za-z]+)"/g, all))) expect([...EXPECTED_REQUESTS, ...NESTED_TYPES], literal).toContain(literal);
  });
  it("no request type that sends, forwards, joins, leaves, deletes, read-marks or changes anything exists in the source", () => {
    const forbidden =
      /\b(sendMessage\w*|sendBotStartMessage|forwardMessages|joinChat\w*|leaveChat|deleteMessages\w*|deleteChat\w*|viewMessages|openChat|closeChat|addChatMember\w*|addChatMembers|setChat\w*|createChat\w*|createNewSupergroupChat|setProfile\w*|setName|setUsername|searchPublicChat\w*|downloadFile|getFile|importContacts|addContact|setBio|toggle\w+|report\w+|banChatMember|setMessage\w*|editMessage\w*|readAllChat\w*|getChatMember\w*|getSupergroupMembers|searchChatMembers|getChatAdministrators|getSupergroupFullInfo|getBasicGroupFullInfo|getMe|getUser\w*|getContacts|searchContacts|getChatHistory|getMessages|getMessageThread\w*|searchChatMessages|getCallbackQueryAnswer|getInlineQueryResults)\b/;
    expect(forbidden.test(all)).toBe(false);
  });
  it("login requests exist only in the interactive login step, never in the update loop or the supervisor", () => {
    const session = sources[`${DIR}/twins_capture/session.py`] ?? "";
    const service = sources[`${DIR}/twins_capture/service.py`] ?? "";
    expect(service).not.toMatch(/Authentication/);
    expect(service).toContain("session.ensure_ready(None)");
    const run = /def run\(self, should_stop\):[\s\S]*?\n    def close/.exec(session)?.[0] ?? "";
    expect(run).not.toMatch(/Authentication|ensure_ready|_login_step|prompt/);
    expect(session).toContain('raise AuthFailure("login_required")');
    expect(sources[MAIN]).toContain("session.ensure_ready(TerminalIO() if command == \"login\" else None)");
  });
  it("a chat-bearing request can only name an approved chat (second allowlist)", () => {
    expect(tdlib).toContain('if "chat_id" in fields and fields["chat_id"] not in allowed_chats');
    expect(sources[`${DIR}/twins_capture/session.py`]).toContain("req(self.cfg.chat_ids, request_type, **fields)");
  });
  it("the pinned TDLib commit is enforced before any client exists, with no fallback library", () => {
    expect(tdlib).toContain('PINNED_TDLIB_COMMIT = "c15d3f5a5de6e3ba5839822c451152e5e18bb700"');
    const service = sources[`${DIR}/twins_capture/service.py`] ?? "";
    expect(service.indexOf("prepare_transport(transport, log)")).toBeLessThan(service.indexOf("Session(transport"));
    expect(all).not.toMatch(/homebrew|\/usr\/local\/lib|dylib/i);
    expect(tdlib.match(/\.td_create_client_id\(/g)?.length).toBe(1);
  });
});

describe("capture client: no content, no secrets, no escape hatches", () => {
  it("nothing prints or writes to the console except the guarded logger and the config-error line", () => {
    expect(all).not.toMatch(/\bprint\(/);
    expect(all.match(/sys\.stdout/g)?.length).toBe(1); // safelog default stream
    expect(sources[`${DIR}/twins_capture/safelog.py`]).toContain("sys.stdout");
    expect(sources[MAIN].match(/sys\.stderr\.write/g)?.length).toBe(2); // usage + config error (names a rule, never a value)
    expect(all).not.toMatch(/traceback|logging\.|\.exception\(/);
  });
  it("no network code outside the ingest client, no shell, no dynamic code, no serialization of untrusted data", () => {
    for (const [file, text] of Object.entries(sources)) {
      if (!file.endsWith("ingest.py")) expect(text, file).not.toMatch(/^\s*(import|from)\s+(socket|http|urllib\.request|requests|ssl|asyncio)\b/m);
      expect(text, file).not.toMatch(/\b(subprocess|os\.system|os\.popen|eval|exec|pickle|marshal|__import__|importlib)\b/);
    }
    expect(sources[`${DIR}/twins_capture/ingest.py`]).not.toMatch(/^\s*(import|from)\s+(urllib|requests)\b/m); // http.client never follows redirects (tested against a real loopback server)
  });
  it("the session directory is never copied, archived or exported (no session transfer); only logout may delete it", () => {
    expect(all).not.toMatch(/\b(shutil\.(copy\w*|move|make_archive)|tarfile|zipfile|os\.rename|os\.link|os\.symlink)\b/);
    expect(sources[MAIN].match(/shutil\.rmtree/g)?.length).toBe(1);
    expect(sources[`${DIR}/twins_capture/session.py`]).toContain("not a link");
  });
  it("every secret and setting comes from the environment: no api_hash, key, token, chat id or URL is hardcoded", () => {
    const PINNED = "c15d3f5a5de6e3ba5839822c451152e5e18bb700";
    const text = all.split(PINNED).join("");
    expect(/-100[0-9]{9,13}/.test(text)).toBe(false);
    expect(/\b[0-9a-f]{32,}\b/.test(text)).toBe(false);
    expect(/\+[0-9]{8,}/.test(text)).toBe(false);
    expect(/https?:\/\/(?!snapshot)/.test(text.replace(/"https\?"|https:\/\/example/g, ""))).toBe(false);
    for (const name of ["TWINS_TELEGRAM_API_ID", "TWINS_TELEGRAM_API_HASH", "TWINS_TELEGRAM_SESSION_DB_KEY", "TWINS_TELEGRAM_ALLOWED_CHAT_IDS", "TWINS_CAPTURE_INGEST_TOKEN", "TWINS_CAPTURE_INGEST_URL"]) {
      expect(sources[`${DIR}/twins_capture/config.py`], name).toContain(`"${name}"`);
    }
    expect(sources[`${DIR}/twins_capture/config.py`]).not.toMatch(/os\.environ/);
  });
  it("message content is read in one module only (mapping) and the logger allows no free-text field", () => {
    for (const [file, text] of Object.entries(sources)) {
      if (!file.endsWith("mapping.py")) expect(text, file).not.toMatch(/\[\s*"text"\s*\]|\.get\("text"\)|\.get\("caption"\)/);
    }
    const fields = /ALLOWED_FIELDS = \{([\s\S]*?)\n\}/.exec(sources[`${DIR}/twins_capture/safelog.py`] ?? "")?.[1] ?? "";
    expect(fields).not.toMatch(/"(text|title|name|phone|code|password|token|hash|message|content|caption|username)"/);
  });
  it("ships only the reviewed files", () => {
    expect(readdirSync(DIR).filter((f) => !f.startsWith("__pycache__")).sort()).toEqual(["README.md", "main.py", "tests", "twins_capture"]);
    expect(readdirSync(`${DIR}/twins_capture`).filter((f) => !f.startsWith("__pycache__")).sort()).toEqual(["__init__.py", "config.py", "ingest.py", "mapping.py", "safelog.py", "service.py", "session.py", "state.py", "tdlib.py"]);
  });
  it("Dockerfile.capture copies the client (services/ is copied wholesale) and python3 is installed", () => {
    const dockerfile = readFileSync("infrastructure/staging/Dockerfile.capture", "utf8");
    expect(dockerfile).toMatch(/^COPY services \.\/services$/m);
    expect(dockerfile).toMatch(/install -y --no-install-recommends libssl3 zlib1g python3/);
  });
});

describe("capture client: payloads are accepted by the REAL API validator", () => {
  it("new, edited (with entities and caption) and deleted payloads validate", () => {
    const script = `
import json, sys
sys.path.insert(0, "${DIR}")
from twins_capture import mapping
chat = -1001000000001
def m(id_, text, edit=0, ctype="messageText", entities=None):
    key = "text" if ctype == "messageText" else "caption"
    return {"id": id_ << 20, "chat_id": chat, "date": 1760000000, "edit_date": edit, "content": {"@type": ctype, key: {"text": text, "entities": entities or []}}, "interaction_info": {"view_count": 10, "forward_count": 2}, "author_signature": "sig"}
ents = [{"offset": 0, "length": 3, "type": {"@type": "textEntityTypeBold"}}, {"offset": 4, "length": 2, "type": {"@type": "textEntityTypeTextUrl", "url": "https://example.com"}}]
out = []
for msg in (m(5, "BUY X", entities=ents), m(6, "edited", edit=1760000100), m(7, "cap", ctype="messagePhoto")):
    mapped, reason = mapping.map_message(msg)
    assert reason is None, reason
    out.append(mapping.build_payload("message", chat, "2026-10-22T00:00:00Z", message=mapped))
out.append(mapping.build_payload("deleted", chat, "2026-10-22T00:00:00Z", ids=[5, 6]))
print(json.dumps(out))
`;
    const payloads = JSON.parse(execFileSync("python3", ["-I", "-c", script], { encoding: "utf8" })) as unknown[];
    expect(payloads).toHaveLength(4);
    for (const body of payloads) {
      const result = validateIngestBody(body, Date.now());
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    }
  });
});

describe("capture client: Python unit tests (scripted fake TDLib, loopback HTTP only)", () => {
  it("all pass", () => {
    const output = execFileSync("python3", ["-E", "-s", "-B", "-W", "error::ResourceWarning", "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"], {
      cwd: DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(output).toBeDefined();
  });
});
