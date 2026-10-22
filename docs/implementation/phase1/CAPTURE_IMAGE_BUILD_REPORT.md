# Staging capture image build report (2026-10-22) - BUILT ONLY, NOT DEPLOYED

| Item | Value |
|---|---|
| Tag (only tag) | `twins-staging:capture-a890f4172` (on the staging host's local Docker; not pushed to any registry) |
| Image ID (local identity; no registry digest exists) | `sha256:693bbad8517ec0ed0efb3e477ad6f6e2782424aba16e6e09a60997379764ad26` |
| Size | 1,098,780,605 bytes (about 1.10 GB; the previous app image is 938 MB) |
| Source | `git archive` of commit `a890f4172e3b7518002e7831c9fad52d391b8993` plus the (uncommitted) `infrastructure/staging/Dockerfile.capture`; 573 files; manifest sha256 `4f38ed21241f8293cdd22f03e3bf66549908e1292c6a7320fef4f2c3cdc85907` |
| Base image | `node:22-bookworm-slim@sha256:c3de60bf...978392` (digest-pinned); Debian packages from snapshot `20261005T000000Z` (main + security) |
| TDLib | commit `c15d3f5a5de6e3ba5839822c451152e5e18bb700`, tree `badabfdb445a403b8438dcff90a72d78825acadb`; fetched by hash, build fails on mismatch (verified in the build log) |
| `/opt/tdlib/libtdjson.so` sha256 (stripped Linux x86_64) | `e4027ad759019c8193d38eea040f77faf9ad7556e27f01de2bc88c5b3ed80a28` |
| Check inside the image (`--network none --read-only`, throwaway) | `td_execute getOption version` = `1.8.68`; `commit_hash` = the pin |
| Build | on the staging host, `--parallel 2`, RAM watchdog (1.5 GiB floor, never triggered); 2026-10-22 15:11:29Z to 15:52:58Z (41 min 29 s); exit 0 |
| Runtime user / contents | `node` (uid 1000); no `.env`, session, key, `api_hash`, pem files; no secret-looking environment variables; `/app` and `/opt/tdlib` read-only |
Not done: no deploy, restart or recreate of any container; no Telegram contact. The capture SERVICE (T2b client code) is not in this image yet: it contains the 0007-aware API/worker code, the pinned library and python3 for the future client.
