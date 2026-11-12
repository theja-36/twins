import type { ReactNode } from "react";
import type { Role } from "@twins/api-contracts";
import type { Screen } from "@/nav/registry";
import { Banner, PageHead, Panel } from "@/ui/primitives";
import { PlannedPanel } from "@/ui/state";

/**
 * The honest placeholder for a screen whose real build is a later stage. It states the purpose, when it arrives, and any backend capability that does not exist (UNAVAILABLE).
 * It shows no data and no number it does not have.
 */
export function ScreenFoundation({ screen, children }: { screen: Screen; children?: ReactNode }) {
  return (
    <>
      <PageHead eyebrow={screen.workspace ?? (screen.kind === "admin" ? "Administration" : "Desk")} title={screen.title}><p>{screen.purpose}</p></PageHead>
      <div style={{ display: "grid", gap: 18 }}>
        <PlannedPanel title={`${screen.title} screen`}>This screen is built in Stage {screen.arrivesIn}. The shell, navigation, role separation and state handling you see here are the foundation it will use.</PlannedPanel>
        {screen.gap && <PlannedPanel title="Backend capability" kind="UNAVAILABLE">{screen.gap}</PlannedPanel>}
        {children}
      </div>
    </>
  );
}
/** Shown when the role may not view a screen. For an ADMIN on a private screen this mirrors the backend, which answers 404 to an administrator. */
export function BlockedPanel({ role, screen }: { role: Role; screen: Screen }) {
  return (
    <>
      <PageHead title={role === "ADMIN" ? "Not available to administrators" : "Not available to you"} />
      <Panel>
        <p style={{ margin: 0 }}>{role === "ADMIN" ? "Trader areas belong to each trader and are not available to administrators. This is by design: the backend answers “not found” to an administrator." : "This area is for administrators."}</p>
        <p className="small muted" style={{ margin: "10px 0 0" }}>{screen.title}</p>
      </Panel>
      <div style={{ marginTop: 14 }}><Banner tone="info" label="Why">Access is decided by the backend on every request; this page only explains it.</Banner></div>
    </>
  );
}
