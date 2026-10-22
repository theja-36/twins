# T1 - local read-only Telegram feasibility check

Purpose: confirm from your Mac that your Telegram account can read the signal channel, and collect **metadata only**. It is a throwaway check: the session it creates is logged out and deleted at the end.
Design and rationale: `docs/implementation/phase1/T1_LOCAL_FEASIBILITY_PLAN.md`. **You run this yourself, in your own Terminal window. Do not run it through an assistant session, do not paste your phone code or password anywhere else.**

## What it prints (the only output)
```
tool=t1 version=1 tdlib=<version> commit=<first 10 hex of the pinned commit>
authorization=ready
channel_id=<id> title="<channel title>" type=channel(broadcast)
membership=<member|left|banned|restricted|administrator|creator>   (your own status, read from the channel object; no member list is ever requested)
protected_content=<true|false>
latest_message: id=<n> date=<iso> edit_date=<iso|none> content_type=<messageText|messagePhoto|...>
events_observable: new=unknown edited=unknown deleted=unknown
```
`--mode listen` additionally prints lines like `[+42s] new ids=123 content_type=messageText`, `edited ids=123`, `deleted ids=123` and a final `events_observable:` line.
It never prints, stores or logs message text, captions, sender names, other chats, your phone number, login code, password, `api_hash` or tokens. It sends only the 13 TDLib request types listed in `ALLOWED_REQUESTS` (no sending, forwarding, joining, leaving, deleting, read-marking). It writes no files itself; TDLib keeps an **encrypted** session database in `~/.twins-t1/tdlib-db`, with message and file storage switched off. It never retries after an error, never logs in on its own, asks for the code and the password at most once each per run, and stops at any Telegram flood-wait.

## T1-B - preparation (once)
1. **TDLib: the pinned build, not Homebrew's.** Homebrew's `tdlib` is the 2021 release 1.8.0, which uses an older login API; the tool refuses it. The tool only runs against the TDLib built from the official repository at the pinned commit `c15d3f5a5de6e3ba5839822c451152e5e18bb700` (release "Update version to 1.8.68."), installed in `~/.twins-t1-build/install/lib/libtdjson.dylib`. The tool reads the build's own version and commit hash (before any client or login exists) and stops unless the version is at least 1.8.6 **and** the commit equals the pin. Build instructions and verification: `docs/implementation/phase1/TDLIB_PINNED_BUILD.md`. You can point the tool at another location with `TWINS_T1_TDJSON=/path/to/libtdjson.dylib`, but the commit check still applies. There is no fallback to any other TDLib on the machine.
2. Get your `api_id` and `api_hash` yourself at https://my.telegram.org/apps (log in with your phone number; keep them private).
3. Create the private directory **outside the repository** (it may already exist and be empty) and enter the inputs without echo or shell history (zsh):
```
umask 077; mkdir -p ~/.twins-t1; chmod 700 ~/.twins-t1
read -rs "?api_id: " X;   printf '%s' "$X" > ~/.twins-t1/api_id;   unset X; echo
read -rs "?api_hash: " X; printf '%s' "$X" > ~/.twins-t1/api_hash; unset X; echo
read -r  "?channel id (the -100... value): " X; printf '%s' "$X" > ~/.twins-t1/channel_id; unset X
python3 -c 'import secrets; print(secrets.token_hex(32))' > ~/.twins-t1/db.key
chmod 600 ~/.twins-t1/*
ls -la ~/.twins-t1        # expect: directory drwx------, four files -rw-------
```
The tool refuses to run if the directory is not mode 700, a file is not mode 600 or owned by you, a file is a symbolic link, or a value has an unexpected format. Error messages never contain the values.

## T1-C - the run (you, in your own Terminal)
```
cd ~/twins
python3 -I tools/t1-feasibility/t1_check.py --mode check
```
It asks for your phone number (international format), then the login code shown in your Telegram app (hidden input), then your two-step password if you have one (hidden input). Telegram will send a "new login" notice; the session is named **TWINS T1 feasibility**.
Optional, afterwards (the session must still exist; this mode never logs in):
```
python3 -I tools/t1-feasibility/t1_check.py --mode listen --seconds 600     # 10 to 900 seconds
```
Paste back **only the printed metadata lines**. If `latest_message: none_returned` appears, run `--mode check` once more (the tool does not retry by itself). If Telegram asks you to wait (`flood-wait`), do not run again before the time given.

## T1-D - cleanup (always do all four)
```
python3 -I tools/t1-feasibility/t1_check.py --mode logout    # ends the session on Telegram's side and deletes ~/.twins-t1/tdlib-db
```
1. Open Telegram > Settings > Devices and confirm **TWINS T1 feasibility** is gone; if it is still listed, terminate it there.
2. `rm -rf ~/.twins-t1` and then `ls -la ~/.twins-t1` (it should say "No such file or directory"). Your `api_id`/`api_hash` stay valid at my.telegram.org; keep them in your password manager if you want to reuse them later.
3. Optional: `brew uninstall tdlib` (Homebrew's copy is not used by the tool; the pinned build in `~/.twins-t1-build` can stay for later reuse or be removed with `rm -rf ~/.twins-t1-build`).
4. `git status` in the repository must show no new files besides this tool, its tests and README.
If the tool cannot start, skip straight to steps 1-3 (terminating the session in Devices is what actually revokes it).

## Exit codes
0 success; 2 error (message printed, nothing sensitive); 3 Telegram flood-wait (stop, wait, do not retry).

## Tests (no Telegram, no native library, no network)
```
python3 -I tools/t1-feasibility/test_t1_check.py          # 57 tests with a scripted fake TDLib
npx vitest run tests/unit/tools                            # static allowlist/safety checks + the Python tests
```

## Limits to keep in mind
`listen` can only show events that happen during its window; `not_seen` does not mean unobservable. Edit and delete handling is proven properly in task T3 on a private test channel you own. The throwaway session has full account access while it exists on this Mac: keep two-step verification on and run cleanup right away.
