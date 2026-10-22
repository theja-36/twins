# TWINS reuse inventory (2026-10-19) - what is actually used vs only mentioned

Method: read-only. Declared dependencies from every `package.json`; installed versions and licence metadata from `node_modules/<pkg>/package.json` and the LICENSE file shipped in the installed package; usage proof from `import` statements in code; whole-lockfile licence tally from `package-lock.json`; the five named projects searched across code, manifests, lockfile and the file tree. **Nothing was installed or cloned; no network was used.** Licence statements about projects that are NOT installed come only from the planning pack and are therefore unverified from source.

## 1. Actually used dependencies
| Component / function | Library (actually used) | Installed | Licence evidence (installed source) | Usage proof | Custom TWINS code that remains necessary |
|---|---|---|---|---|---|
| Job queue (producer, consumer, retries, stalled recovery) | **BullMQ** | 6.3.11 (declared ^6.3.11 in api, worker, scheduler) | `package.json` MIT; `LICENSE` "MIT License, Copyright (c) 2018 BullForce Labs AB" | `apps/api/src/index.ts:35`, `services/worker/src/index.ts`, `services/scheduler/src/index.ts` (11 files incl. tests) | job payload contracts, deterministic job id (`tg-<chat>-<message revision>`), correlation metadata, permanent-vs-retryable classification, producer bound/503 semantics, database-level idempotency (BullMQ is not exactly-once) |
| Redis client for BullMQ | **ioredis** (a BullMQ optional peer, installed explicitly) | 5.11.1 | `package.json` MIT; `LICENSE` "The MIT License (MIT) Copyright (c) 2015-2022 Zihua Li" | `apps/api/src/index.ts:36`, worker, scheduler (9 files) | explicit client construction (BullMQ's native-ESM path cannot lazy-load it), producer `maxRetriesPerRequest: 3` vs worker `null`, ownership/shutdown |
| HTTP API | **Fastify** | 4.29.1 (declared ^4.28.0) | `package.json` MIT; `LICENSE` "MIT License, Copyright (c) 2016-2024 The Fastify Team" | `apps/api/src/index.ts:34` (only importer) | webhook auth hook, JSON-parser wrapper and error handler (no body leakage), routes, correlation, bounded enqueue. Transitive: pino 9.14.0 (MIT, request logging), secure-json-parse 2.7.0 (BSD-3-Clause), light-my-request 5.14.0 (BSD-3-Clause, used by `app.inject` in tests) |
| ORM / query builder | **drizzle-orm** | 0.45.2 | `package.json` Apache-2.0; **no LICENSE file ships in the installed package** (metadata only; upstream repo per `repository` field) | 77 files, e.g. `apps/api/src/index.ts:37`, `packages/database/src/client.ts` | the whole schema (~30 tables), CHECK constraints, unique keys, hand-reviewed migrations 0000-0004, idempotent insert/resolve helpers |
| Migration generator | **drizzle-kit** (dev) | 0.31.10 | `package.json` MIT; no LICENSE file in installed package | `packages/database/drizzle.config.ts` (the only importer) | migration review/hand edits (e.g. `parser_version` backfill), snapshot discipline |
| PostgreSQL driver / pool | **pg** (node-postgres) | 8.23.0 (declared ^8.12.0; deps pg-pool 3.14.0, pg-protocol, pg-types, pgpass, pg-connection-string, all MIT) | `package.json` MIT; `LICENSE` "MIT License, Copyright (c) 2010 - 2021 Brian Carlson" | `packages/database/src/client.ts:1` (only production importer) | pool ownership, bounded handle, pool error listener, shutdown |
| Scheduler cron | **node-cron** | 4.6.0 | `package.json` ISC; `LICENSE.md` "ISC License, Copyright (c) 2016, Lucas Merencia" | `services/scheduler/src/index.ts:25` | watchlist/cadence policy, job construction |
| Env loading (dev tool) | dotenv | 16.6.1 | BSD-2-Clause; LICENSE present | `packages/database/drizzle.config.ts:1` only | - |
| Language/tooling (dev) | TypeScript 5.9.3 (Apache-2.0, LICENSE.txt), vitest 2.1.9 (MIT), eslint 9.39.5 + @typescript-eslint 8.70.0 (MIT), prettier 3.9.6 (MIT; used via `npm run format`, not imported), tsx 4.23.13 (MIT; `db:migrate`, `dev`, and `node --import tsx` in the crash test), @types/* (MIT) | as listed | package.json + LICENSE files present | config files / scripts | - |
| Market data | **no library**: custom adapter calling Yahoo's unofficial chart endpoint with Node's global `fetch` | n/a | n/a. Data terms for that endpoint are not evidenced anywhere in the repo | `adapters/market/src/yahoo.ts` (~line 101) | all of it: normalization, quality gates, provider contract |
| Telegram | **no library** (no grammY/telegraf): custom update normalization over the Fastify webhook | n/a | n/a | `adapters/telegram/src/botApi.ts` | all of it (identity layers, revisions, chat-id scoping) |
| Signal parsing, decision, evidence, entity resolution | **no library**: deterministic custom code | n/a | n/a | `packages/{signals,decision-intelligence,entities,dataquality,ingestion}` | all of it |
| Crypto / HTTP helpers | Node built-ins (`node:crypto` timingSafeEqual/randomUUID/createHash, `node:http` STATUS_CODES, `node:net` in a test forwarder) | Node v26.5.0 used; engines >=20 | Node licence not inventoried here | `packages/shared/src/crypto.ts` etc. | - |
**Whole-lockfile licence tally (405 installed third-party packages):** MIT 333, Apache-2.0 21, ISC 14, BSD-3-Clause 8, BSD-2-Clause 7, 0BSD 1, BlueOak-1.0.0 1 (`minimatch`, dev-only), Python-2.0 1 (`argparse`, a dev-only transitive of eslint); no GPL/AGPL/LGPL/SSPL/unknown. The 19 "none declared" entries are TWINS's own workspace packages. This is a declared-licence tally, not a full SBOM or licence-text review.
**Technical indicators: none.** `grep` for RSI/SMA/EMA/MACD/ATR/Bollinger/VWAP/moving-average/indicator in all product code returns 0 matches; no indicator library is in any manifest or in the lockfile. The pipeline uses evidence-count/quality rules only, not indicator maths.

## 2. Reference-only repositories (text in the planning pack only; not in the code, manifests, lockfile or file tree)
| Repository | What the planning pack says (observed from public docs on 2026-10-19, NOT verified from source here) | Evidence it is not integrated |
|---|---|---|
| **OpenAlgo** | AGPL-3.0; architecture/broker-lifecycle reference; "no whole-platform fork" (decision 007, status proposed) | 0 code/manifest/lockfile hits; no submodule, no vendored directory; mentioned only in `TWINS_Planning_Pack/{08,09,14,16}` |
| **vectorbt-backtesting-skills** | MIT per its README; agent research workflow examples, "reference only after review"; its dependency licences still apply | same |
| **Backtrader** | GPL-3.0; optional event-driven research reference; "not drop-in execution" | same |

## 3. Planned but not integrated
| Item | State in this repository |
|---|---|
| **TA-Lib** (Python wrapper) | "preferred candidate" for indicators/parity fixtures (BSD-2-Clause wrapper, C library to be reviewed separately). **Not integrated**: no Python anywhere in the repo, no indicator code. |
| **VectorBT** | "restricted-use review" (Apache-2.0 + Commons Clause per the pack); optional offline research. **Not integrated**. |
| Broker SDKs (Dhan, Zerodha mentioned) | `adapters/broker` is a 35-line stub with no vendor dependency; nothing imports it |
| AI provider | `packages/ai` is a 21-line stub; not imported by anything |
| Macro / news adapters | `adapters/macro` (16 lines) and `adapters/news` (17 lines) are stubs; `packages/entities` (908 lines) is custom |
| Dashboard (React + Vite proposed) | `apps/web` has no source files |
| Python research service, model artifacts | not started |
| Container images (PostgreSQL, Redis) | used only as the test compose (`postgres:16-alpine`, `redis:7-alpine`); no app images yet |

## 4. Rejected / deferred candidates (per the planning pack's own register)
No whole-platform OpenAlgo fork; VectorBT not a default SaaS dependency; Backtrader not an execution engine; crypto-bot forks and OHLC equity templates avoided; no library approved for automatic order placement. All are decisions in the pack, not anything implemented.

## 5. Gaps and cautions found while inventorying
- TWINS itself declares **no licence** (no `LICENSE`, no `license` field) and there is **no third-party notices file**; Apache-2.0 components (drizzle-orm, TypeScript, plus transitive cluster-key-slot, denque) carry notice obligations if redistributed.
- drizzle-orm/drizzle-kit ship **no LICENSE file** in the installed packages, so their licence evidence is the `license` metadata only; fetch the upstream licence text at the pinned tag when producing notices.
- The planning pack's own warning stands: it never inspected installed versions; this inventory is the first record of them. No dependency advisory scan (`npm audit`) was run (needs network); `npm ci` printed deprecation warnings for `eslint@9.39.5` and `@esbuild-kit/*` (visible in the saved local-CI log). Fastify 4.x support status was not checked.
- Optional peers of BullMQ (`bullmq-otel`, `redis`) and Drizzle's long optional-peer list are not installed and not used.
- The Yahoo endpoint is unofficial; its terms of use and suitability beyond local/staging development are not evidenced.
- Pinning: floating caret ranges in manifests are resolved by the lockfile; Docker image tags in the test compose are major-version tags, not digests.
