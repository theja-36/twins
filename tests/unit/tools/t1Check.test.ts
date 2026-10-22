import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Static safety checks for the T1 local feasibility tool (tools/t1-feasibility/t1_check.py) and a runner for its Python
 * unit tests. No Telegram, no native TDLib, no network: the Python tests use a scripted fake transport.
 */
const DIR = "tools/t1-feasibility";
const source = readFileSync(`${DIR}/t1_check.py`, "utf8");

/** The exact TDLib request types the tool may send (plan T1, section 1). Changing this list is a reviewed change. */
const EXPECTED_REQUESTS = [
  "checkAuthenticationCode",
  "checkAuthenticationPassword",
  "close",
  "getChat",
  "getChatHistory",
  "getOption",
  "getSupergroup",
  "loadChats",
  "logOut",
  "setAuthenticationPhoneNumber",
  "setLogStream",
  "setLogVerbosityLevel",
  "setTdlibParameters",
].sort();
const NESTED_TYPES = ["chatListArchive", "chatListMain", "logStreamEmpty"];

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const matches = (rx: RegExp, text: string) => [...text.matchAll(rx)].map((m) => m[1] as string);
const stripStrings = (text: string) => text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
const methodBody = (name: string) => {
  const m = new RegExp(`def ${name}\\([^)]*\\):\\n([\\s\\S]*?)(?=\\n    def |\\n\\n\\n|\\nclass |\\ndef )`).exec(source);
  if (!m) throw new Error(`method ${name} not found`);
  return m[1] ?? "";
};

describe("T1 tool: exact TDLib request allowlist", () => {
  it("ALLOWED_REQUESTS in the source is exactly the reviewed list", () => {
    const block = /ALLOWED_REQUESTS = frozenset\(\s*\{([\s\S]*?)\}\s*\)/.exec(source)?.[1] ?? "";
    expect(sorted(matches(/"([A-Za-z]+)"/g, block))).toEqual(EXPECTED_REQUESTS);
  });
  it("every request the code can send is on the list, and every listed request is used", () => {
    const used = sorted([...matches(/\breq\(\s*"([A-Za-z]+)"/g, source), ...matches(/\.request\(\s*"([A-Za-z]+)"/g, source)]);
    expect(used).toEqual(EXPECTED_REQUESTS);
  });
  it("only allowed '@type' literals appear in the source (requests plus three nested helper objects)", () => {
    const literals = sorted(matches(/"@type"\s*:\s*"([A-Za-z]+)"/g, source));
    for (const literal of literals) expect([...EXPECTED_REQUESTS, ...NESTED_TYPES], literal).toContain(literal);
  });
  it("no request type that sends, forwards, joins, leaves, deletes, reads-marks or changes anything exists in the source", () => {
    const forbidden =
      /\b(sendMessage\w*|sendBotStartMessage|forwardMessages|joinChat\w*|leaveChat|deleteMessages\w*|deleteChat\w*|viewMessages|openChat|closeChat|addChatMember\w*|addChatMembers|setChat\w*|createChat\w*|createNewSupergroupChat|setProfile\w*|setName|setUsername|searchPublicChat\w*|downloadFile|getFile|importContacts|addContact|setBio|toggle\w+|report\w+|banChatMember|setMessage\w*|editMessage\w*|readAllChat\w*|getChatMember\w*|getSupergroupMembers|searchChatMembers|getChatAdministrators|getSupergroupFullInfo|getBasicGroupFullInfo|getMe|getUser\w*|getContacts|searchContacts)\b/;
    expect(forbidden.test(source)).toBe(false);
  });
  it("membership is read only from supergroup.status: no member list, per-member lookup or account request exists", () => {
    const gather = methodBody("gather");
    expect(gather).toContain('self.request("getSupergroup"');
    expect(gather).toContain("supergroup_id_of(chat)");
    expect(gather).toContain("membership_name(supergroup)");
    expect(gather).toMatch(/raise T1Error\("could not determine the membership status/);
    expect(/member_id|my_id|user_id/.test(source)).toBe(false);
    expect(source).not.toMatch(/ChatMember|SupergroupMembers|ChatAdministrators/);
  });
  it("the native transport re-checks the allowlist on every send and execute", () => {
    expect(methodBody("send")).toContain("ensure_allowed(");
    expect(methodBody("execute")).toContain("ensure_allowed(");
    expect(source.match(/\.td_send\(/g)?.length).toBe(1);
    expect(source.match(/\.td_execute\(/g)?.length).toBe(1);
  });
  it("TDLib logging is switched off before the first session request", () => {
    const run = /def run\(args, transport, io, home\):[\s\S]*?Session\(transport/.exec(source)?.[0] ?? "";
    const verbosity = run.indexOf('req("setLogVerbosityLevel"');
    const stream = run.indexOf('req("setLogStream"');
    expect(verbosity).toBeGreaterThan(0);
    expect(stream).toBeGreaterThan(verbosity);
    expect(run).toContain("new_verbosity_level=0");
    expect(run).toContain("LOG_STREAM_EMPTY");
  });
});

describe("T1 tool: what the code is able to do", () => {
  it("imports only the reviewed standard-library modules (no network, process or third-party code)", () => {
    const imports = sorted(matches(/^(?:import|from)\s+([A-Za-z_][\w.]*)/gm, source));
    expect(imports).toEqual(["argparse", "base64", "ctypes", "datetime", "getpass", "json", "os", "re", "shutil", "stat", "sys", "time"]);
  });
  it("contains none of the dangerous calls", () => {
    for (const word of ["print(", "subprocess", "os.system", "os.popen", "eval(", "exec(", "__import__", "socket", "urllib", "http.", "ssl", "requests", "pickle", "marshal"]) {
      expect(source.includes(word), word).toBe(false);
    }
  });
  it("opens files only for reading and deletes only through the guarded session-directory function", () => {
    const opens = source.match(/\bopen\([^)]*\)/g) ?? [];
    expect(opens).toEqual(['open(path, "r")']);
    expect(source.match(/shutil\.rmtree\(/g)?.length).toBe(1);
    expect(methodBody("delete_session_dir")).toContain("shutil.rmtree(");
    expect(source.match(/\.write\(/g)?.length).toBe(2); // sys.stdout.write and sys.stderr.write only
    expect(source).toMatch(/sys\.stdout\.write\(/);
    expect(source).toMatch(/sys\.stderr\.write\(/);
    expect(/open\([^)]*["'][wax+][b]?["']/.test(source)).toBe(false);
  });
  it("login secrets are read only at the tool's own prompts (hidden for the code and the password)", () => {
    expect(source.match(/getpass\.getpass\(/g)?.length).toBe(2);
    expect(source.match(/\binput\(/g)?.length).toBe(1);
    expect(source).not.toMatch(/os\.environ\.get\("[A-Z_]*(PHONE|CODE|PASSWORD|HASH|SECRET|TOKEN)/);
    expect(sorted(matches(/os\.environ\.get\("([A-Z_0-9]+)"/g, source))).toEqual(["TWINS_T1_TDJSON"]);
  });
  it("secrets and message content never flow into output calls (checked on code with string literals removed)", () => {
    const outputLines = source.split("\n").filter((line) => /\bio\.(out|err)\(|stdout\.write|stderr\.write/.test(line));
    expect(outputLines.length).toBeGreaterThan(10);
    for (const line of outputLines) {
      const code = stripStrings(line);
      expect(/\b(phone|password|api_hash|db_key_b64|db_key|code_|raw|response|history|messages|text|caption|content)\b/.test(code), line.trim()).toBe(false);
    }
  });
  it("accepts no command-line option that could carry a secret or content", () => {
    const options = matches(/add_argument\(\s*"(--[a-z-]+)"/g, source);
    expect(sorted(options)).toEqual(["--mode", "--seconds"]);
  });
  it("only a single fixed private directory is used and the tool never restarts a login by itself", () => {
    expect(source.match(/expanduser\("~"\)/g)?.length).toBe(1);
    expect(source).toContain('HOME_DIR_NAME = ".twins-t1"');
    expect(source).not.toMatch(/while True/);
    expect(source).not.toMatch(/\bretry\b\s*\(/);
  });
  it("refuses unpinned TDLib builds: version and commit are verified before any client exists, and there is no fallback library", () => {
    expect(source).toContain('PINNED_TDLIB_COMMIT = "c15d3f5a5de6e3ba5839822c451152e5e18bb700"');
    expect(source).toContain("MIN_TDLIB = (1, 8, 6)");
    expect(source).not.toMatch(/homebrew|\/usr\/local/i);
    const run = /def run\(args, transport, io, home\):[\s\S]*?\n\n\ndef main/.exec(source)?.[0] ?? "";
    expect(run.indexOf("verify_library(transport)")).toBeGreaterThan(run.indexOf('req("setLogStream"'));
    expect(run.indexOf("verify_library(transport)")).toBeLessThan(run.indexOf("Session(transport"));
    expect(source.match(/\.td_create_client_id\(/g)?.length).toBe(1);
  });
  it("is not executable by group/other and ships only the reviewed files", () => {
    expect(readdirSync(DIR).filter((f) => !f.startsWith("__pycache__")).sort()).toEqual(["README.md", "t1_check.py", "test_t1_check.py"]);
  });
});

describe("T1 tool: documentation", () => {
  const readme = readFileSync(`${DIR}/README.md`, "utf8");
  it("README covers T1-B, T1-C and T1-D with the cleanup steps", () => {
    for (const needle of ["T1-B", "T1-C", "T1-D", "TDLIB_PINNED_BUILD", "TWINS_T1_TDJSON", "c15d3f5a5de6e3ba5839822c451152e5e18bb700", "--mode check", "--mode listen", "--mode logout", "rm -rf ~/.twins-t1", "Settings > Devices", "umask 077", "chmod 700"]) {
      expect(readme, needle).toContain(needle);
    }
  });
  it("neither README nor tool contain a channel id, user id, phone number, hash or token", () => {
    const PINNED_COMMIT = "c15d3f5a5de6e3ba5839822c451152e5e18bb700"; // the one public, intentional 40-hex value (the TDLib pin)
    for (const raw of [readme, source]) {
      const text = raw.split(PINNED_COMMIT).join("");
      expect(/-100[0-9]{9,13}/.test(text)).toBe(false);
      expect(/\+[0-9]{8,}/.test(text)).toBe(false);
      expect(/\b[0-9a-f]{32,}\b/.test(text)).toBe(false);
    }
  });
});

describe("T1 tool: Python unit tests (scripted fake TDLib)", () => {
  it("all pass", () => {
    const output = execFileSync("python3", ["-I", "-W", "error::ResourceWarning", `${DIR}/test_t1_check.py`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
    });
    expect(output).toBeDefined();
  });
});
