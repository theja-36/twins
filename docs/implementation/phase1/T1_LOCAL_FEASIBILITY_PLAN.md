# Task T1 - Local read-only feasibility check (PLAN ONLY; NOT EXECUTED; separate approval required)

Purpose: confirm, from your Mac with a throwaway session of your existing Telegram account, that the account can read the signal channel, and collect only metadata. Nothing is stored, exported, forwarded or sent. The channel id is `<SOURCE_CHANNEL_ID>`; it is read from a file outside the repository at run time and is never written into the repo.

## 1. What the tool does (and does not)
Single-file Python 3 tool, **standard library only** (no third-party packages), loading TDLib's JSON interface through `ctypes` from Homebrew's `tdlib` formula (official TDLib source, packaged bottle). Proposed location in the repo (source only, no secrets): `tools/t1-feasibility/t1_check.py` plus a short README and a static test.
**Modes** (each a separate command):
- `--mode check` (default): login (interactive), then read metadata, then close. Session stays on disk for a following `listen`/`logout`.
- `--mode listen --seconds N` (optional, N <= 900): after `check`, print only update **types and message ids** that arrive on the channel (`new`, `edited`, `deleted`) with counts - never content. Shows whether edits/deletes are observable for the real channel if any happen in the window.
- `--mode logout`: calls TDLib `logOut` (invalidates the session on Telegram's side) and deletes the local session directory.
**Printed output (the only output):**
```
tool=t1 version=...  tdlib=...
authorization=ready
channel_id=<as configured>   title="<channel title>"   type=channel(broadcast)
membership=<member|left|banned|administrator|creator>
protected_content=<true|false>
latest_message: id=<n> date=<iso> edit_date=<iso|none> content_type=<messageText|messagePhoto|...>
events_observable: new=<unknown|yes> edited=<unknown|yes> deleted=<unknown|yes>   (from listen mode only)
```
**Never printed, saved or kept:** message text or captions, sender names, other chats' titles or ids, phone number, codes, passwords, `api_hash`, tokens, TDLib raw JSON. TDLib logging is disabled first (`setLogVerbosityLevel 0` and an empty log stream). The message object returned for "latest message" is reduced to `id`, `date`, `edit_date` and the content's `@type` name inside one function that is unit-tested; the tool never dumps or logs raw responses.
**TDLib options:** `use_message_database=false`, `use_file_database=false`, `use_secret_chats=false`, `use_chat_info_database=true` (needed to resolve the chat), `database_encryption_key` = random 32 bytes (base64) read from a 0600 file, `device_model="TWINS T1 feasibility"` so the session is easy to recognise in Settings > Devices.
**Allowed TDLib request types (static test enforces this exact allowlist; amended 2026-10-22 after the first run):** `setLogVerbosityLevel`, `setLogStream`, `getOption`, `setTdlibParameters`, `setAuthenticationPhoneNumber`, `checkAuthenticationCode`, `checkAuthenticationPassword`, `loadChats`, `getChat`, `getSupergroup`, `getChatHistory` (limit 1), `logOut`, `close` (13). `getMe` and `getChatMember` were removed: for a broadcast channel Telegram refuses `getChatMember` to non-administrators ("Member list is inaccessible"), so membership is read from `getChat` -> `type.supergroup_id` -> `getSupergroup` -> `status` (the current user's own status). No member-list, administrator-list or per-member request is allowed in any form. Anything else - in particular `sendMessage*`, `forwardMessages`, `joinChat*`, `leaveChat`, `deleteMessages`, `viewMessages`, `addChatMember*`, `setChat*` - fails the test. `viewMessages` is not called, so no read marking or view counting.
**Failure behaviour:** at most one phone-code request and one code/password attempt per run; any Telegram error (including flood-wait/"retry after") stops the run with a short message - no retry loops, no automatic re-run.

## 2. Files and secrets handling
In the repository (no secrets): `tools/t1-feasibility/t1_check.py`, `tools/t1-feasibility/README.md`, `tests/unit/tools/t1Check.test.ts`.
Outside the repository, private directory `~/.twins-t1/` (mode 0700), all files 0600, never committed (outside the repo tree):
| File | Content | Created by |
|---|---|---|
| `api_id`, `api_hash` | from https://my.telegram.org/apps, obtained by you | you |
| `channel_id` | `<SOURCE_CHANNEL_ID>` | you |
| `db.key` | 32 random bytes (hex) for TDLib's database encryption | generated locally |
| `tdlib-db/` | the throwaway session (encrypted) | the tool |
Phone code and any 2FA password are typed **only into the tool's own prompts** (the code and password prompts do not echo). They are never written to a file, argument, environment variable or log, and never pasted anywhere else. **You run the login in your own Terminal window, not through the assistant**, so the assistant cannot see them.

## 3. Exact commands (for you to run after approval; the tool code is written and tested first)
```
# one-time preparation (zsh)
brew info tdlib                       # check the formula/version before installing
brew install tdlib                    # local install only; approval needed
umask 077; mkdir -p ~/.twins-t1; chmod 700 ~/.twins-t1
read -rs "?api_id: " X;   printf '%s' "$X" > ~/.twins-t1/api_id;   unset X
read -rs "?api_hash: " X; printf '%s' "$X" > ~/.twins-t1/api_hash; unset X
read -r  "?channel id (the -100... value): " X; printf '%s' "$X" > ~/.twins-t1/channel_id; unset X
python3 -c 'import secrets; print(secrets.token_hex(32))' > ~/.twins-t1/db.key
chmod 600 ~/.twins-t1/*

# the feasibility run (open your own Terminal; you type the phone number, code and password)
cd ~/twins && python3 -I tools/t1-feasibility/t1_check.py --mode check
python3 -I tools/t1-feasibility/t1_check.py --mode listen --seconds 600    # optional

# cleanup (always)
python3 -I tools/t1-feasibility/t1_check.py --mode logout
```
Telegram will send a "new login" notice to your devices for the throwaway session; that is expected.

## 4. Cleanup and deletion steps (mandatory, in this order)
1. `--mode logout` (server-side invalidation and local data deletion). If the tool cannot start, skip to 3.
2. In the Telegram app: Settings > Devices; confirm the session named "TWINS T1 feasibility" is gone; if it is still listed, terminate it.
3. `rm -rf ~/.twins-t1` (removes `api_id`, `api_hash`, `channel_id`, `db.key`, session); confirm with `ls -la ~/.twins-t1` that it no longer exists. (`api_id`/`api_hash` remain valid at my.telegram.org; they are application identifiers, keep them in your password manager if you want to reuse them for T2b.)
4. Optional: `brew uninstall tdlib` if you do not want it installed (T2b builds TDLib from a pinned source tag in a container, so the Homebrew copy is not needed later).
5. Confirm nothing from the session is in the repository: `git status` shows no new files other than the tool, README and test.

## 5. Test plan (before you run anything; no Telegram contact)
- Static test: the set of `@type` strings used in the source is a subset of the allowlist; forbidden names absent; no `requests`/`urllib`/`socket` imports (no network code of its own); no file writes outside `~/.twins-t1/`; no `print` of raw response objects.
- Unit test of the reduction function with a fake message containing text/caption/sender: output contains only `id`, `date`, `edit_date`, content type name; the text never appears.
- Unit test that argument handling rejects unknown modes and caps `--seconds` at 900.
- The repository's existing suites stay green; lint and typecheck clean.

## 6. Acceptance criteria
You paste back only the metadata block above. Accepted when: authorization ready; membership shows you as a member of the channel; the protected-content flag is reported; a latest message id is reported; `listen` reports at least `new` observed (or you note that no message arrived); logout verified in Devices; local directory deleted.

## 7. Rollback
Nothing is installed in the repo beyond the tool, README and test (revert the commit). The only external state is the throwaway Telegram session (removed in step 4.1-4.2) and the optional Homebrew package. If anything goes wrong, terminate the session in Settings > Devices first.

## 8. Approval boundary
- **T1-A:** approve writing the tool, README and tests (local files; no Telegram contact).
- **T1-B:** approve `brew install tdlib` (or you run it yourself).
- **T1-C:** you run the login and the check yourself; approval for me to look at the pasted metadata only.
- **T1-D:** cleanup performed by you per section 4; I verify the repository state only.
Nothing in T1 touches the VPS, the database, the queue, the API or any bot.

## 9. Risks
The throwaway session has full account access while it exists on the Mac (mitigations: 2FA on, short lifetime, encrypted local database, immediate logout); an incorrect login attempt can trigger Telegram's throttling of code requests (the tool never retries); Homebrew's TDLib bottle is a third-party packaging of the official source (version printed and checked); the "events observable" answer for the real channel depends on events actually occurring during the listen window, so edit/delete handling is proven properly only on a private test channel in T3.
