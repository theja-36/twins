# TWINS Frontend — Design System ("Trading Research Desk")

Status: PROPOSED (corrected after the Stage 09.0 final review). Reference implementation of tokens and components: `mockups/assets/desk.css` (verified with axe-core: 32 page/theme/width combinations, 0 violations). Screenshots: `mockups/screenshots/`. All mockup data is synthetic and labelled.

## 1. Character

A premium research desk, not a trading arcade: calm, dense where it must be, never flashing. Dark-first with a deliberately designed light "paper" variant (not an inversion). Borders over shadows. Motion ≤ 200 ms and fully disabled under `prefers-reduced-motion`.

## 2. Typography

| Role | Face | Use |
|---|---|---|
| Display | Newsreader (serif) | page titles, section heroes, empty-state headlines |
| UI | IBM Plex Sans | all controls, labels, prose |
| Numeric | IBM Plex Mono, `font-variant-numeric: tabular-nums` | every price, quantity, money, id, timestamp |

Scale (rem): 0.75 / 0.8125 / 0.875 (base) / 1 / 1.125 / 1.375 / 1.75 / 2.25. Uppercase micro-labels get +0.06em tracking. Body measure ≤ 70ch. Fonts are self-hosted via `next/font` (no runtime third-party requests; CSP `font-src 'self'`).

## 3. Colour tokens

Defined as CSS variables on `:root` (dark default), redefined under `@media (prefers-color-scheme: light)` guarded by `:not([data-theme="dark"])` and under `[data-theme="light"]`; Tailwind consumes them through `theme.extend.colors = { token: "var(--token)" }`. No component uses a literal colour.

| Token | Dark | Light | Meaning |
|---|---|---|---|
| `--bg / --bg2 / --bg3` | warm graphite ramp | paper ramp | page / panel / raised |
| `--tx / --tx2 / --tx3` | text ramp (`--tx3` ≥ 4.5:1) | `--tx3:#5a564d` | primary / secondary / muted |
| `--line` | hairline | hairline | borders |
| `--accent` | brass | `#6f4c0e` | TRADER accent, focus ring |
| `--admin` | steel-blue | steel-blue (AA) | ADMIN accent + role chip |
| `--gain / --loss` | teal / coral | `--gain:#0a6a4f` | **profit and loss only** |
| `--dec` | violet | `#4636a8` | decision workflow |
| `--ord` | blue | `#12507f` | order workflow |
| `--pos` | sand | `#5a4620` | position workflow |
| `--warn` | amber | `#6e4f00` | caution, STALE |

Rule: **P&L colours never signal status, and workflow hues never signal profit.** A red/green pair is never the only cue: P&L always has sign and arrow; status always has text and shape.

## 4. Status vocabulary (never conflate)

| Domain | Shape | Values (from backend enums) |
|---|---|---|
| Decision | violet pill with leading dot | PENDING, APPROVED, REJECTED, EXPIRED, CANCELLED, SUPERSEDED; outcome QUALIFIED etc. shown separately. Approval-action states INVALIDATED, ALREADY_ACTIONED, NOT_PENDING, NOT_QUALIFIED are separate notices, not badges |
| Order | blue outlined rectangle | per `PAPER_ORDER_STATES` |
| Position | sand ringed pill | OPEN, CLOSED (+ partial) |
| Data source | `FIXTURE` hatched badge · `LIVE` badge specified, **never rendered until a live source is verified** (analytics return `liveStatus:"UNAVAILABLE"`) | |
| Freshness | `CURRENT` / `STALE` chip with age | from snapshot metadata |
| Availability | dashed `NOT AVAILABLE` / `PLANNED` | availability registry |

Enumerations are imported from `@twins/api-contracts`; an unknown value renders a neutral "UNKNOWN (value)" badge rather than crashing (forward compatibility).

## 5. Money, quantity, time

- The backend sends money as decimal **strings** (orders, fills, positions, `maxLossAtStop`, portfolio facts) and some values as **numbers** (candidate prices, `lots`, `quantity`, `sizeMultiplier`). Both are **display-only**. `formatMoney("1100920.00")` → `₹ 11,00,920.00` (Indian grouping) by string manipulation; numbers are formatted to fixed decimals without arithmetic. The frontend performs **no financial or risk calculation** (no totals, P&L, R-multiples, sizing, exposure, validity). A tiny sign/zero helper for presentation (arrow, colour) is allowed. Charts may convert to numbers for drawing only; that module is the single exception to the `no-number-money` lint rule.
- There is no unrealised P&L, mark price or live balance anywhere in the backend; the design system has no component for them.
- Quantities are integers as strings/numbers per contract; lots are shown with units.
- Times are ISO strings displayed in `Asia/Kolkata` with the zone suffix; relative age is secondary text. Market-hours context uses IST.
- Signed P&L: `+₹ 945.00 ▲` / `−₹ 310.00 ▼`, minus is U+2212.

## 6. Layout and responsive behaviour

| Width | Shell |
|---|---|
| ≥ 1100 | left rail 252 px (five workspaces + role chip), topbar, safety strip |
| 720–1099 | collapsible rail (icons + labels on hover/focus), topbar |
| < 720 | bottom navigation (five workspaces), single-column content, tables become `.tblwrap` horizontal scroll regions (focusable) or `.drow` stacked rows |

Safety strip (always visible): `PAPER TRADING ONLY · Live execution disabled` and the data-source badge for the current screen. No horizontal page scroll at 390 px (verified in mockups).

## 7. Component inventory

Primitives: Button (primary/secondary/quiet/danger), IconButton, Input, Select, Textarea, Checkbox, Switch, Tabs (arrow-key), Dialog (focus trap, Esc), Toast (polite live region), Tooltip (hover+focus), Skeleton, Divider, Card/Panel.

Data: DataTable (sort, column visibility, sticky header, row focus), KeyValueList, Stat, Sparkline, Meter, Timeline, Ladder (entry / stop / targets), Chart wrapper (Recharts + always a "View as table" toggle), Pagination ("Load more" — backend is limit-only).

Domain: `DecisionStatusBadge`, `OrderStatusBadge`, `PositionStatusBadge`, `DataSourceBadge`, `FreshnessChip`, `PnlValue`, `MoneyValue`, `RiskMeter`, `PermissionGate` (UX only), `ApprovalCard`, `PriceLadder`, `PositionRow`, `ReasonList` (backend `reasons[]`).

State: `DataRegion` (renders the eight states from one `DataState`), `StateBanner`, `EmptyPanel`, `UnavailablePanel`, `DeniedPanel`, `ErrorPanel` (shows correlation id, retry).

Each component specifies: props typed from contracts, all states, keyboard behaviour, ARIA, and a Vitest + axe test (see testing doc).

## 8. Interaction rules

- Approve, reject and cancel open a confirmation dialog stating the instrument, quantity and maximum loss **as returned by the backend** and "Approving records your decision; it does not place an order". Buttons are disabled while pending. The `idempotencyKey` (request **body** field, 8–128 chars) is created when the dialog opens and reused on retry (approve, reject, watch, unwatch). Reason: optional for approve and reject; required, 5–300 characters, for cancel.
- After a successful action the affected queries are invalidated and the UI shows the *server's* returned status, not an optimistic guess.
- Polling: 15 s on the approvals queue and positions while the tab is visible; 60 s elsewhere; paused when hidden; a visible "last updated" timestamp on every polled region.

## 9. Accessibility baseline

WCAG 2.2 AA. Contrast: text ≥ 4.5:1, UI ≥ 3:1 in both themes (tokens above tuned for it). Visible 2 px focus ring in `--accent`. Targets ≥ 24 px (44 px on touch). Every chart has a data-table equivalent. No information by colour alone. Live regions for toasts and state changes. Scrollable regions are keyboard-focusable and labelled. Details in [testing-and-accessibility](testing-and-accessibility.md).

## 10. Mockups

`mockups/index.html` is the gallery: Overview, Approval Center, Opportunity Detail, Paper Trading, Learning Insights, Admin System Health, States & Components. All numbers are synthetic and clearly labelled MOCKUP / FIXTURE. Corrected in the review: the mockups no longer show unrealised P&L, mark prices or computed open notional; positions show **stop-loss** and **realised P&L**, the portfolio shows backend-style **allocated notional** (₹ 11,00,920.00 = 428,715.00 + 592,480.00 + 79,725.00, shown as one reported figure) and realised P&L. Navigation matches the documented workspaces; the ADMIN console shows no private trader screens, and its events/audit and user-administration areas are PLANNED panels.
