"use client";
/**
 * DataRegion renders the eight data states from ONE DataState value (docs/frontend/architecture.md §6). Screens pass the state from deriveState(); they never draw their own.
 * Every non-READY state explains itself in words and names a next step where one exists; none fabricates content.
 */
import type { ReactNode } from "react";
import type { DataState } from "@twins/api-contracts";
import { AvailabilityBadge } from "./badges";
import { Button } from "./primitives";

function StateBox({ tone, icon, title, children, role }: { tone?: "warn" | "err"; icon: string; title: ReactNode; children?: ReactNode; role?: "status" | "alert" }) {
  return (
    <div className={`state ${tone ?? ""}`.trim()} role={role}>
      <span className="ic" aria-hidden="true">{icon}</span>
      <div><h3>{title}</h3>{children && <p>{children}</p>}</div>
    </div>
  );
}
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div role="status" aria-busy="true" aria-live="polite" style={{ display: "grid", gap: 10 }}><span className="sr">Loading</span>{Array.from({ length: rows }, (_, i) => <div key={i} className="skel" style={{ width: `${88 - i * 14}%` }} />)}</div>;
}
export interface DataRegionProps {
  state: DataState; children?: ReactNode;
  /** Name of what is being shown, used in the messages ("approvals"). */
  what: string;
  emptyHint?: string; unavailableReason?: string; staleNote?: string; partialNote?: string; deniedNote?: string; errorId?: string | null;
  onRetry?: () => void;
}
export function DataRegion({ state, children, what, emptyHint, unavailableReason, staleNote, partialNote, deniedNote, errorId, onRetry }: DataRegionProps) {
  switch (state) {
    case "LOADING": return <Skeleton />;
    case "EMPTY": return <StateBox icon="0" title={`No ${what} yet`} role="status">{emptyHint ?? "Nothing to show here."}</StateBox>;
    case "ERROR": return <StateBox tone="err" icon="!" title={`${what} could not be loaded`} role="alert">{errorId ? `Reference ${errorId}. ` : ""}Nothing was changed.{onRetry && <> <Button onClick={onRetry}>Try again</Button></>}</StateBox>;
    case "DENIED": return <StateBox icon="×" title="Not available to you" role="status">{deniedNote ?? "You don’t have access to this."}</StateBox>;
    case "UNAVAILABLE": return <StateBox icon="—" title={<><AvailabilityBadge kind="UNAVAILABLE" /> {what}</>} role="status">{unavailableReason ?? "The backend does not provide this yet."}</StateBox>;
    case "STALE": return <div><div className="banner" role="status"><b>STALE</b><span>{staleNote ?? "This may be out of date; the latest refresh did not complete."}{onRetry && <> <Button onClick={onRetry}>Refresh</Button></>}</span></div>{children}</div>;
    case "PARTIAL": return <div><div className="banner info" role="status"><b>PARTIAL</b><span>{partialNote ?? "Some sections could not be loaded; the rest is shown."}</span></div>{children}</div>;
    case "READY": return <>{children}</>;
  }
}
/** A planned capability: says what is missing and, where known, who does it today. Never "coming soon" without a stated gap. */
export function PlannedPanel({ title, children, kind = "PLANNED" }: { title: string; children: ReactNode; kind?: "PLANNED" | "UNAVAILABLE" }) {
  return <StateBox icon="—" title={<><AvailabilityBadge kind={kind} /> {title}</>} role="status">{children}</StateBox>;
}
