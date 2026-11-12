// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DATA_STATES } from "@twins/api-contracts";
import { violations } from "@/test/axe";
import { AvailabilityBadge, DecisionStatusBadge, FreshnessChip, MoneyValue, OrderStatusBadge, PnlValue, PositionStatusBadge, ProvenanceBadge } from "./badges";
import { Dialog } from "./dialog";
import { Banner, Button, Field } from "./primitives";
import { DataRegion, PlannedPanel } from "./state";
import { DataTable } from "./table";

afterEach(cleanup);
beforeAll(() => { HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); }; });

describe("status vocabulary", () => {
  it("each domain uses its own badge class (distinct shapes), text always present", () => {
    const { container } = render(<><DecisionStatusBadge state="PENDING" /><OrderStatusBadge status="FILLED" /><PositionStatusBadge status="OPEN" /></>);
    expect(container.querySelector(".b-dec")?.textContent).toBe("PENDING"); expect(container.querySelector(".b-ord")?.textContent).toBe("FILLED"); expect(container.querySelector(".b-pos")?.textContent).toBe("OPEN");
  });
  it("underscored backend values read naturally; unknown values render neutrally and never crash", () => {
    render(<><OrderStatusBadge status="PARTIALLY_FILLED" /><DecisionStatusBadge state="BRAND_NEW" /></>);
    expect(screen.getByText("PARTIALLY FILLED")).toBeTruthy(); expect(screen.getByText("UNKNOWN (BRAND_NEW)").className).toContain("b-neutral");
  });
  it("FIXTURE is badged; LIVE is NEVER rendered as LIVE (no live source is verified)", () => {
    render(<><ProvenanceBadge kind="FIXTURE" /><ProvenanceBadge kind="LIVE" /></>);
    expect(screen.getByText("FIXTURE").className).toContain("b-fix");
    const live = screen.getByText("LIVE · NOT VERIFIED"); expect(live.className).toContain("b-na"); expect(screen.queryByText("LIVE")).toBeNull();
  });
  it("availability and freshness", () => { render(<><AvailabilityBadge kind="UNAVAILABLE" /><FreshnessChip freshness="STALE" /><FreshnessChip freshness="CURRENT" asOf="2031-01-06T05:00:00Z" /></>); expect(screen.getByText("NOT AVAILABLE")).toBeTruthy(); expect(screen.getByText("STALE")).toBeTruthy(); expect(screen.getByText(/CURRENT/)).toBeTruthy(); });
  it("results carry a sign and an accessible name, not just a colour; money is displayed exactly", () => {
    render(<><PnlValue value="3810.00" /><PnlValue value="-2260.00" /><PnlValue value="0.00" /><MoneyValue value="1100920.00" /></>);
    expect(screen.getByLabelText(/profit/).textContent).toContain("+"); expect(screen.getByLabelText(/loss/).textContent).toContain("−"); expect(screen.getByLabelText(/no result/)).toBeTruthy(); expect(screen.getByText(/11,00,920\.00/)).toBeTruthy();
  });
});
describe("DataRegion renders every one of the eight states from one value", () => {
  for (const s of DATA_STATES) it(`state ${s}`, async () => {
    const { container } = render(<DataRegion state={s} what="items" onRetry={() => undefined}><div>CONTENT</div></DataRegion>);
    const showsContent = s === "READY" || s === "STALE" || s === "PARTIAL"; expect(!!screen.queryByText("CONTENT")).toBe(showsContent);
    if (s === "LOADING") expect(container.querySelector("[aria-busy='true']")).toBeTruthy();
    if (s === "ERROR") expect(screen.getByRole("alert")).toBeTruthy();
    if (s === "UNAVAILABLE") expect(screen.getByText("NOT AVAILABLE")).toBeTruthy();
    if (s === "STALE" || s === "PARTIAL") expect(screen.getByText(s)).toBeTruthy();
    expect(await violations(container)).toEqual([]);
  });
  it("ERROR offers a retry and DENIED/EMPTY explain themselves; none shows content", () => {
    const retry = vi.fn(); render(<DataRegion state="ERROR" what="orders" onRetry={retry} errorId="abc" />); fireEvent.click(screen.getByRole("button", { name: "Try again" })); expect(retry).toHaveBeenCalled(); expect(screen.getByText(/Reference abc/)).toBeTruthy();
    cleanup(); render(<DataRegion state="EMPTY" what="decisions" emptyHint="Nothing needs you." />); expect(screen.getByText("No decisions yet")).toBeTruthy(); expect(screen.getByText("Nothing needs you.")).toBeTruthy();
  });
  it("a planned panel names what is missing", () => { render(<PlannedPanel title="Capital edit" kind="UNAVAILABLE">No write route exists.</PlannedPanel>); expect(screen.getByText("No write route exists.")).toBeTruthy(); expect(screen.getByText("NOT AVAILABLE")).toBeTruthy(); });
});
describe("controls", () => {
  it("fields have real labels, link hints and announce errors", async () => {
    const { container } = render(<Field id="x" label="Reason" hint="At least 5 characters" error="Too short" />);
    const input = screen.getByLabelText("Reason"); expect(input.getAttribute("aria-invalid")).toBe("true"); expect(input.getAttribute("aria-describedby")).toBe("x-hint x-err"); expect(screen.getByRole("alert").textContent).toBe("Too short");
    expect(await violations(container)).toEqual([]);
  });
  it("buttons default to type=button (never submit by accident); variants map to classes", () => { render(<><Button>a</Button><Button variant="primary">b</Button><Button variant="danger">c</Button></>); expect(screen.getByText("a").getAttribute("type")).toBe("button"); expect(screen.getByText("b").className).toContain("primary"); expect(screen.getByText("c").className).toContain("danger"); });
  it("banner is a labelled note", () => { render(<Banner label="PAPER">Simulated.</Banner>); expect(screen.getByRole("note").textContent).toContain("PAPER"); });
});
describe("table", () => {
  it("is a focusable, labelled scroll region with a caption and column headers", async () => {
    const { container } = render(<DataTable caption="Positions" rows={[{ id: "1", n: "A" }, { id: "2", n: "B" }]} rowKey={(r) => r.id} selectedKey="2" columns={[{ key: "n", header: "Name", render: (r) => r.n }, { key: "m", header: "More", hideOnMobile: true, align: "right", render: () => "x" }]} />);
    const region = screen.getByRole("region", { name: "Positions (scrollable)" }); expect(region.getAttribute("tabindex")).toBe("0"); expect(within(region).getAllByRole("columnheader").length).toBe(2); expect(container.querySelector("tr.sel")?.textContent).toContain("B");
    expect(await violations(container)).toEqual([]);
  });
});
describe("dialog", () => {
  it("opens and closes with its prop, is labelled by its title, and Escape (cancel) asks to close", () => {
    const onClose = vi.fn(); const { rerender, container } = render(<Dialog open={false} onClose={onClose} title="Confirm">Body</Dialog>);
    const d = container.querySelector("dialog")!; expect(d.hasAttribute("open")).toBe(false); expect(d.getAttribute("aria-labelledby")).toBe("dlg-title");
    rerender(<Dialog open onClose={onClose} title="Confirm">Body</Dialog>); expect(d.hasAttribute("open")).toBe(true); expect(screen.getByRole("heading", { name: "Confirm" })).toBeTruthy();
    fireEvent(d, new Event("cancel", { cancelable: true })); expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(onClose.mock.calls.length).toBeGreaterThan(1);
  });
});
