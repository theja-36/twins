# T1 evidence report - local read-only Telegram feasibility (2026-10-22)

Provenance of this report: the run was performed **by the owner in the owner's own Terminal**. The assistant did not observe the run, did not read `~/.twins-t1`, session files or secrets, and made no Telegram call. Everything in section 2 is **owner-reported**. Identifiers are placeholders on purpose: `<CHANNEL_ID>` (the source channel), `<ACCOUNT>` (the logged-in personal account). This file contains no credentials, phone numbers, message content or session data and must stay that way.

## 1. What was tested
| Item | Value |
|---|---|
| Tool | `tools/t1-feasibility/t1_check.py` (tool version 1; read-only; 13 allowed TDLib request types; metadata-only output) |
| TDLib | pinned self-built **1.8.68**, upstream commit `c15d3f5a5de6e3ba5839822c451152e5e18bb700`; library sha256 `9f5c023a4b2822237bfead95df0d3241215f3728081724ab4af63a2e4dbba652` (`docs/implementation/phase1/TDLIB_PINNED_BUILD.md`) |
| Test status before the run | Python 57/57; repository unit suite 704/704; typecheck clean; lint 0 errors |
| Mode used | `--mode check` (login at the tool's own prompts, by the owner). `--mode listen`: **not reported** (see section 3) |
| Account / channel | `<ACCOUNT>` (existing personal account) / `<CHANNEL_ID>` (subscriber-only broadcast channel) |

## 2. Result (owner-reported)
| Check | Result |
|---|---|
| Pinned TDLib version and commit accepted by the tool's gate | **passed** (expected version and commit) |
| `authorization` | `ready` |
| Configured broadcast channel accessible | **yes** |
| `membership` | `member` (read from `getChat` -> `getSupergroup` -> `status`; no member list requested) |
| `protected_content` | `false` (at the time of the run; the flag is controlled by the channel owner and can change) |
| Latest message metadata readable | **yes**: `latest_message: id=<LATEST_MESSAGE_ID> date=<ISO> edit_date=<ISO or none> content_type=<TYPE>` (values kept by the owner, not recorded here) |
| Output contained message text, sender names, phone or secrets | not reported; the tool is built and tested so that it cannot emit them |
Conclusion: **basic feasibility is established** - the account can read the channel as a member through the pinned TDLib, and the tool can read metadata of the latest message without member-list access.

## 3. What remains UNVERIFIED (do not treat as done)
1. **New / edit / delete event observation on the real channel.** Not shown by T1. Edits and deletes of channel messages are only provable on a private test channel the owner controls (task T3 prerequisite). `not_seen` from `listen` would not prove "not observable".
2. **Live capture** of any message (nothing was captured or stored; T3).
3. **History import** (T3h): no history call beyond one `limit=1` read was made; flood-wait behaviour under load is untested.
4. **Edit history availability**: Telegram does not expose it; first-seen-already-edited handling is design only.
5. **Session reuse after the fix.** Whether the second run reused the existing session without a new login: `[owner to fill: yes / no]`.
6. **Long-running behaviour**: reconnects, update gaps, session revocation handling - untested; T2b/T3.
7. **Rate-limit behaviour** of the owner's account against this channel.

## 4. Defects found during T1 and their resolution (all local, all tested)
| # | Finding | Resolution |
|---|---|---|
| 1 | Homebrew `tdlib` is the 2021 tag v1.8.0 (older login API) | replaced by the pinned self-built 1.8.68; the tool refuses any other build (version >= 1.8.6 and commit equal to the pin, checked before a client exists) |
| 2 | `getChatMember` is refused for non-administrators on broadcast channels ("Member list is inaccessible") - confirmed in the pinned TDLib source | membership is read from `supergroup.status`; `getMe` and `getChatMember` removed from the allowlist (13 requests); fail-closed when the status cannot be determined |
| 3 | A validation regex accepted a trailing newline (`$` vs `\Z`) | fixed for all validation patterns; regression tests |
| 4 | Several guard tests only passed because a wrong code returns an error that aborts first | added "re-asked without an error" fake variants for phone, code and password |

## 5. T1-D cleanup status - **NOT YET RECORDED**
The owner's message contained the unfilled placeholder `[fill in actual logout and Devices-revocation result]`. The assistant will not assume or infer any of the following; each must be filled in by the owner:
| Step | Result (owner to fill) |
|---|---|
| `python3 -I tools/t1-feasibility/t1_check.py --mode logout` output (exit status and the two result lines) | `[ ]` |
| Telegram app > Settings > Devices: session "TWINS T1 feasibility" gone, or terminated manually | `[ ]` |
| `rm -rf ~/.twins-t1` done and the directory confirmed absent | `[ ]` |
| Homebrew `tdlib` 1.8.0 (not used by the tool) kept or uninstalled | `[ ]` |
| `~/.twins-t1-build` (pinned build, 520 MB) kept for reuse | kept unless the owner says otherwise |
Until the first three lines are filled in, **T1 is not closed** and the throwaway session on this Mac must be treated as still active. Closing T1 is a precondition for T2b (any session on the VPS) and should precede it.

## 6. Consequences for the plan
- **T2a** (schema + internal ingest endpoint) does not depend on event observation and can proceed to review.
- **T3** (live capture of one message) must first prove edit/delete observation on a private test channel owned by the owner, then capture a single real message.
- **protected_content=false** answers the earlier open question for now; the capture service must **re-check the flag on every start and record any change** as an event, and pause if it becomes true.
- The membership-from-supergroup-status approach and the pinned-TDLib gate carry over unchanged to the capture service (T2b).
- No requirement changed: personal account, API history import, raw retention, deletions as events, separate approval bot.
