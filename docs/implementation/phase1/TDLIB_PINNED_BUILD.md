# Pinned TDLib build (T1 on the Mac now; reused for the VPS capture service in T2b)

Status 2026-10-22: **built and verified on the Mac** (not yet used against Telegram). Nothing here connects to Telegram.
Result record (full detail in `~/.twins-t1-build/PIN.txt`, outside the repository): build tool `cmake` 4.4.4 from the PyPI wheel `cmake-4.4.4-py3-none-macosx_10_10_universal2.whl` (sha256 `883962a72b1b3a16ff445427f24c8caca9797dd9e563bbe208cbcd89e877f9d3`) in the isolated venv `~/.twins-t1-build/venv`; configure and build exit 0, 291 s (4 jobs), 0 errors; library `~/.twins-t1-build/install/lib/libtdjson.dylib`, arm64, sha256 `9f5c023a4b2822237bfead95df0d3241215f3728081724ab4af63a2e4dbba652`; all five JSON-interface symbols exported; dependencies: `openssl@3`, zlib, libc++, libSystem only; synchronous `td_execute` returns version `1.8.68` and commit `c15d3f5a...` (= the pin).

## 1. The pin
| Item | Value |
|---|---|
| Repository | https://github.com/tdlib/td.git (official Telegram TDLib repository) |
| Release marker | upstream commit "Update version to 1.8.68." by the maintainer, 2026-10-08 |
| Commit | `c15d3f5a5de6e3ba5839822c451152e5e18bb700` |
| Tree | `badabfdb445a403b8438dcff90a72d78825acadb` |
| Version in tree | `project(TDLib VERSION 1.8.68 ...)` |
| Scheme (`td/generate/scheme/td_api.tl`) sha256 | `cea6311c8a4ba0c73460b4f632b1e2b771499b32cf531f7297ee315a5a83eae5` |
| Not used | Homebrew `tdlib` (= the 2021 tag v1.8.0, old login API), unpinned `master`, 1.8.69 (one day old when chosen) |
Why this one: upstream publishes no tags after v1.8.0 and identifies releases by "Update version to ..." commits on `master`. 1.8.68 is such a commit, is an ancestor of `master`, was 13 days old when selected, and the 133 commits to the next release (1.8.69) are documentation and internal changes with no security announcement (the repository lists 0 security advisories). Upstream commits are **unsigned**, so integrity rests on the content-addressed commit and tree hashes, checked after the fetch and again from inside the built library (section 4). Bumping the pin is a deliberate, reviewed change (section 5).

## 2. Verification already done (read-only, before any compile)
- The commit and tree were recorded in `~/.twins-t1-build/PIN.txt` **before** downloading.
- Fetched with `git fetch --depth 1 origin <commit>` into `~/.twins-t1-build/src`; `HEAD` and `HEAD^{tree}` equal the pin; `git fsck` clean; 1,678 files; no submodules; clean worktree.
- Offline API compatibility: every request, field and response shape the T1 tool uses exists in the pinned scheme (15 request types, nested objects, updates, authorization states); the old-API markers (`tdlibParameters`, `checkDatabaseEncryptionKey`, `authorizationStateWaitEncryptionKey`) are absent.
- The scheme documents `getOption` as callable synchronously for `version` and `commit_hash`; the library embeds the git commit it was configured from (`GitCommitHash.cpp.in`, from `get_git_head_revision`).

## 3. Build (to run after approval of the missing build tool)
Prerequisites: Apple clang (Command Line Tools: present), `gperf` (`/usr/bin/gperf`: present), macOS SDK with zlib (present), `openssl@3` 3.6.3 (present in the Cellar; the linked OpenSSL is now 4.0.3, so the build names 3 explicitly), **`cmake` (missing)**. Options: (a) `brew install cmake` (global install; brew may touch dependencies, as it did for tdlib), or (b) an isolated copy inside `~/.twins-t1-build` (a Python virtual environment with the PyPI `cmake` wheel installed with `--require-hashes`, no system change). Option (b) was approved and used.
```
cd ~/.twins-t1-build
test "$(git -C src rev-parse HEAD)" = c15d3f5a5de6e3ba5839822c451152e5e18bb700      # abort if different
mkdir -p build install/lib
cmake -S src -B build -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3 -DCMAKE_INSTALL_PREFIX=$HOME/.twins-t1-build/install
cmake --build build --target tdjson --parallel 4        # JSON library only; expected 15-40 minutes, peak a few GB of RAM
install -m 0755 build/libtdjson.dylib install/lib/libtdjson.dylib
```
Inputs fixed: Release build, no `master`, no network access needed after the fetch (CMake does not download dependencies for the `tdjson` target). On failure the process stops: no retries with other versions.
Verification after the build (not the T1 tool, no client, no Telegram): `nm -gU` shows `_td_create_client_id`, `_td_send`, `_td_receive`, `_td_execute`, `_td_set_log_message_callback`; `otool -L` shows only system libraries plus `openssl@3`; a tiny script calls the **synchronous** `td_execute` for `getOption version` and `getOption commit_hash` and must print `1.8.68` and the pinned commit; the dylib's sha256 is appended to `PIN.txt`.
The T1 tool then finds the library at `~/.twins-t1-build/install/lib/libtdjson.dylib` (or via `TWINS_T1_TDJSON`), and **refuses** any library whose version is below 1.8.6 or whose reported commit differs from the pin, before it creates a client or asks for any login detail.
Known dependency: the dylib records the absolute path of `openssl@3`. If Homebrew's `openssl@3` were removed, the library would stop loading (it is currently needed by Homebrew's `node`, so `brew autoremove` should keep it).

## 4. How the same pin is reused for the VPS capture service (T2b)
Principle: one pin, one verification procedure, two build contexts.
1. **Multi-stage Docker build, TDLib stage pinned end to end.** Base image by digest; compiler packages from a fixed Debian snapshot date (so package versions are reproducible); `git init`, `git fetch --depth 1 origin $TD_COMMIT`, then **fail the build** unless `git rev-parse HEAD` equals `$TD_COMMIT` and `HEAD^{tree}` equals `$TD_TREE`; `cmake -DCMAKE_BUILD_TYPE=Release` and `--target tdjson`; the final stage copies only `libtdjson.so` plus the runtime packages (OpenSSL, zlib) into a slim non-root image. Source and compiler never reach the runtime image.
2. **Identity of the artifact.** TDLib is not guaranteed to build byte-identically; so we record the **resulting `libtdjson.so` sha256 and the image digest** per build, and verify at start-up (and in a throwaway `docker run --rm --network none` smoke test) that `getOption commit_hash` equals the pin and `version` is at least 1.8.6 - the same gate the T1 tool already applies.
3. **Build location and resources.** The VPS is shared (about 8 GB RAM available, other tenants). Build there only in a quiet window with the memory watchdog used for the previous image build, `--parallel 2`, and no other stopped services; or build on the Mac for `linux/amd64` (slower under emulation) and load the image. The approval for T2b covers the source download, the packages and the build separately.
4. **Same client code, same allowlist discipline.** The capture service starts from the T1 transport/session code (ctypes, stdlib only, request allowlist enforced at runtime and by a static test). It adds only the update handling and the read calls T2b needs (new/edited/deleted updates, bounded history reads) and the same "no send/forward/join/leave/delete" rule; any new request type is a reviewed change to the allowlist.
5. **Supply-chain notes.** No prebuilt third-party binaries; the only third-party code in the runtime path is OpenSSL/zlib from the distribution. The build downloads only: the base image (by digest), Debian packages (pinned snapshot), and the TDLib commit (verified by hash).
6. **Session storage unchanged:** encrypted TDLib database (`database_encryption_key`), session volume excluded from backups, read-only root filesystem, no capabilities (see the ingestion architecture).

## 5. Updating the pin later
A new pin requires: choosing an "Update version to ..." commit that is an ancestor of `master` and at least about two weeks old; recording commit and tree before download; fetching by hash; re-running the offline scheme-compatibility check against the tool's request/field list (a CI script is proposed for T2b); reading the commit list since the old pin for anything touching authorization, connections or storage; rebuilding; and repeating the symbol, version and commit verification. The T1 tool and the capture service change their pinned commit constant in the same reviewed commit.

## 6. Risks
Upstream commits are unsigned (mitigated by content addressing and the in-library commit check); a self-built TDLib is not covered by Homebrew's bottle process or by a distribution's security updates (you own the update cadence: check upstream roughly monthly); compile time and memory on the VPS; the absolute OpenSSL path dependency on the Mac build; TDLib's API still evolves between releases (the tool refuses unknown or old builds instead of guessing).
