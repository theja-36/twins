import type { ReactNode } from "react";

export interface Column<T> { key: string; header: string; align?: "left" | "right"; hideOnMobile?: boolean; /** Wide tables only: free text that may wrap at word boundaries (everything else stays on one line). */ wrap?: boolean; render: (row: T) => ReactNode }
/**
 * A data table inside a focusable, labelled scroll region (so keyboard users can scroll it). The caption is for screen readers.
 * `wide` is for tables with many columns: the table keeps its natural width, scrolls sideways inside its own region, shows EVERY column at every screen width, and never breaks a word, symbol or number.
 */
export function DataTable<T>({ columns, rows, caption, rowKey, selectedKey, wide = false }: { columns: Column<T>[]; rows: readonly T[]; caption: string; rowKey: (r: T) => string; selectedKey?: string; wide?: boolean }) {
  return (
    <div className="tblwrap" role="region" tabIndex={0} aria-label={`${caption} (scrollable)`}>
      <table className={wide ? "tbl-wide" : undefined}>
        <caption className="sr">{caption}</caption>
        <thead><tr>{columns.map((c) => <th key={c.key} scope="col" className={`${c.align === "right" ? "r" : ""} ${c.hideOnMobile ? "hide-m" : ""}`.trim()}>{c.header}</th>)}</tr></thead>
        <tbody>{rows.map((r) => <tr key={rowKey(r)} className={selectedKey === rowKey(r) ? "sel" : ""} aria-selected={selectedKey === undefined ? undefined : selectedKey === rowKey(r)}>{columns.map((c) => <td key={c.key} className={`${c.align === "right" ? "r" : ""} ${c.hideOnMobile ? "hide-m" : ""} ${wide && c.wrap ? "wrap" : ""}`.trim()}>{c.render(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
