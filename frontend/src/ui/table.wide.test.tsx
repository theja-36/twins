// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTable } from "./table";

afterEach(cleanup);
const cols = [{ key: "a", header: "Instrument", render: (r: { a: string }) => r.a }, { key: "b", header: "Net P&L", align: "right" as const, hideOnMobile: true, render: () => "6,172.18" }, { key: "c", header: "Note", hideOnMobile: true, wrap: true, render: () => "free text may wrap" }];
describe("DataTable wide mode (opt-in)", () => {
  it("default tables are unchanged: no wide class and no wrap class", () => {
    const { container } = render(<DataTable caption="t" rows={[{ a: "X" }]} rowKey={(r) => r.a} columns={cols} />);
    expect(container.querySelector("table")?.className).toBe(""); expect(container.querySelector("td.wrap")).toBeNull();
  });
  it("wide tables get the wide class, keep every column (including hideOnMobile ones), and mark only wrap columns as wrappable", () => {
    const { container } = render(<DataTable wide caption="t" rows={[{ a: "X" }]} rowKey={(r) => r.a} columns={cols} />);
    expect(container.querySelector("table")?.className).toBe("tbl-wide"); expect(container.querySelectorAll("th")).toHaveLength(3); expect(container.querySelectorAll("td.wrap")).toHaveLength(1);
    expect(container.querySelector("td.wrap")?.textContent).toBe("free text may wrap"); expect(container.querySelector("td.r")?.textContent).toBe("6,172.18");
  });
  it("keeps the accessible semantics: a labelled, focusable scroll region, a caption, and column headers with scope", () => {
    const { container } = render(<DataTable wide caption="Outcome history" rows={[{ a: "X" }]} rowKey={(r) => r.a} columns={cols} />);
    const region = container.querySelector(".tblwrap")!; expect(region.getAttribute("role")).toBe("region"); expect(region.getAttribute("tabindex")).toBe("0"); expect(region.getAttribute("aria-label")).toBe("Outcome history (scrollable)");
    expect(container.querySelector("caption")?.textContent).toBe("Outcome history"); expect([...container.querySelectorAll("th")].every((h) => h.getAttribute("scope") === "col")).toBe(true);
  });
});
