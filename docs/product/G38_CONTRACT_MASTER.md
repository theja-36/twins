# G-38 contract master: canonical design, status and source recommendation

**Status:** the canonical record, validation, adaptation, effective-dated resolution and cross-source comparison are IMPLEMENTED and TESTED (`packages/signals/src/options/canonicalContract.ts`, 11 unit tests, local). Persistence, the API route and any real data are NOT STARTED and BLOCKED on an approved authoritative source. G-38 stays OPEN.

## Why a wrapper, not a seventh model
The repository already holds six contract/instrument shapes that do not talk to each other: `VerifiedContract` (signals, default `unconfiguredContractMaster`), the manual reference master, the Dhan provider snapshot (`ProviderContractRow`, richest provenance: sha256, retrievedAt, importer version), planning `InstrumentSpec` (only one with effective dates and source kind; no strike/expiry), the agents' `InstrumentReference` and the Kite `KiteInstrument`, plus a bare `instruments` table that cannot hold a derivative. Sizing, risk and execution read only `InstrumentSpec`; the options assessment reads only `VerifiedContract`. The canonical record adapts these; it replaces none of them yet.

## Canonical record (`canonical-contract-v1`)
| Field | Rule |
|---|---|
| `canonicalId` | `ctr_` + 32 hex of sha256(exchange, segment, kind, underlying, expiry, strike, optionType). Provider-independent: the same contract has the same id from any source. A provider token is never the identity (brokers state tokens are reused after expiry) |
| exchange, segment, kind (OPTION/FUTURE), underlying | as listed by the source |
| `expiryDate` | calendar-valid `YYYY-MM-DD`; provider raw text with a time of day is kept only in provenance |
| `strike` | decimal string without trailing zeros (never a float); null for futures |
| `optionType` | CE or PE; null for futures |
| `lotSize` | positive integer |
| `tickSize`, `tickSizeUnit` | decimal string; unit RUPEES, PAISE or UNSPECIFIED (Dhan's unit is undocumented, so it stays UNSPECIFIED, never converted) |
| `identifiers[]` | `{namespace, value}` such as `dhan:securityId`; informational |
| `effectiveFrom` (inclusive), `effectiveTo` (exclusive), `version`, `supersedes` | a lot-size change is a NEW version, never an edit; old versions are retained |
| `validation` | EXCHANGE_VERIFIED, MANUAL_VERIFIED, PROVIDER_LISTED, SYNTHETIC, UNVERIFIED. Only the first two may feed sizing (`isSizingEligible`); a provider listing can never be labelled exchange-verified |
| `provenance` | source, sourceUrl, retrievedAt, contentSha256, importerVersion, retrievalTimeSource |

## Reason codes (validation)
`ID_MISMATCH, BAD_EXPIRY, BAD_STRIKE, OPTION_NEEDS_STRIKE_AND_TYPE, FUTURE_HAS_STRIKE_OR_TYPE, LOT_SIZE_INVALID, TICK_SIZE_INVALID, EFFECTIVE_RANGE_INVALID, PROVENANCE_MISSING, SYNTHETIC_MISLABELLED, PROVIDER_CANNOT_BE_EXCHANGE_VERIFIED, NO_IDENTIFIER`. Resolution answers `RESOLVED`, `NOT_FOUND` (unknown, invalid or out of range) or `CONFLICT` (records in force disagree on lot or tick size): never a guess.

## Not built (specified only)
- **Table `contract_master`** (append-only, shared platform data, no owner; unique (canonical_id, version); CHECKs mirroring the validation; trigger forbidding update/delete; effective ranges not overlapping per canonical_id and source). Needs a migration (next number 0044) and CI proof.
- **Read API** (session, `strategies:read`): `GET /contracts/{canonicalId}?at=YYYY-MM-DD` returns the record in force or 404; `GET /contracts?underlying&expiry&limit&offset` bounded, deterministic order. Errors 401/403/404/422 as the other session routes. Documented in the session OpenAPI document when built.
- **Consumers:** the options assessment, planning sizing (lot and tick by contract, not only by underlying) and execution lot handling would read the canonical record; today they do not, and the compatibility step is a separate, tested change.
- **Ownership/access:** contracts are shared reference data; no user data is stored; writes only by an operator import job, never by a user route.

## Source evaluation (checked 2026-11-09; V = read from the page, S = search snippet only, U = unverified)
| Source | Status | Notes |
|---|---|---|
| NSE contract master files and the NSE Masters Data specification (v1.10) | exchange, authoritative | daily; which files are public vs member-only: U (nseindia.com timed out); redistribution terms: U; cost: U |
| BSE equity-derivatives contract master | exchange, authoritative | covers SENSEX and BANKEX (S); production file location and terms: U |
| Upstox instrument JSON | broker | public gzipped JSON, daily, NSE and BSE (V); expired contracts dropped (V); terms not on the page |
| Dhan scrip master | broker | already imported by `dhanImport.ts`; BSE F&O coverage U; terms not on the page |
| Zerodha Kite instruments | broker | needs API key and token; paid plan stated by the price research as 500 INR/month |
| NSE Data & Analytics / vendors | licensed | price and terms not published in what was reachable |
All broker pages say exchange tokens are reused after expiry. No checked source documents expired-contract history: it must be built by archiving each day's file from the day a licence is confirmed, or bought.

**Recommendation:** primary = the NSE contract master plus the BSE equity-derivatives contract master (authoritative, field spec published); alternative/cross-check = Upstox public JSON, with Dhan as the second broker source we already parse. **Approval requested:** see `STAGE_03_DECISION_PACKAGE.md` item B. No provider is claimed approved or licensed.

## Acceptance criteria to close G-38
Approved source configured; an operator import produces `EXCHANGE_VERIFIED` records with sha256 and retrieval time; the table and read API exist with PostgreSQL integration tests; a candidate's contract verification resolves through them; unknown/ambiguous contracts are refused; cross-source conflicts are surfaced; sizing reads lot and tick from the canonical record; CI green.
