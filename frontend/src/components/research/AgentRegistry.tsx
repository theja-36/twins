"use client";
import { useAgentRegistry } from "@/api/researchHooks";
import { deriveState } from "@/state/dataState";
import { formatDecimal } from "@/lib/format";
import { Banner } from "@/ui/primitives";
import { DataRegion } from "@/ui/state";
import { DataTable } from "@/ui/table";
import { Section } from "@/components/desk/parts";
import { upperWords } from "@/components/insights/shared";

const list = (v: readonly string[]): string => (v.length ? v.join(", ") : "none");

/** The research agent registry: contract metadata only, read-only. Nothing here can change an agent, a weight, a dependency or a permission. */
export function AgentRegistry() {
  const q = useAgentRegistry(), d = q.data, state = deriveState({ loading: q.isLoading, error: q.error, hasData: !!d, empty: !!d && d.agents.length === 0 });
  return (
    <Section id="reg-h" title="Research agents">
      <DataRegion state={state} what="the agent registry" emptyHint="The registry lists no agents." onRetry={() => void q.refetch()}>
        {d && <>
          <Banner tone="info" label="Read-only">{d.note} This page cannot change any agent, weight, dependency or permission.</Banner>
          <p className="small muted" style={{ margin: "10px 0" }}>{d.agents.length} agents cover {d.roles.length} research roles{d.extraSpecialists.length ? `, plus extra specialist${d.extraSpecialists.length > 1 ? "s" : ""}: ${d.extraSpecialists.join(", ")}` : ""}. “Required” means a missing result halts the package; “can block” means the agent may return a blocking verdict.</p>
          <DataTable wide caption="Research agents" rows={d.agents} rowKey={(a) => a.agentId} columns={[
            { key: "a", header: "Agent", render: (a) => <><b>{a.name}</b><span className="xs muted mono" style={{ display: "block" }}>{a.agentId} · v{a.version}</span><span className="xs muted only-phone">{a.role ? upperWords(a.role) : "—"} · {a.required ? "Required" : "Optional"}{a.canBlock ? " · can block" : ""}</span></> }, { key: "r", header: "Role", render: (a) => (a.role ? upperWords(a.role) : "—") },
            { key: "q", header: "Required", render: (a) => (a.required ? "Required" : "Optional") }, { key: "b", header: "Can block", render: (a) => (a.canBlock ? "Yes" : "No") }, { key: "ad", header: "Advisory only", render: (a) => (a.advisoryOnly ? "Yes" : "No") },
            { key: "w", header: "Weight", align: "right", render: (a) => <span className="num">{formatDecimal(a.weight)}</span> }, { key: "t", header: "Timeout (ms)", align: "right", render: (a) => <span className="num">{formatDecimal(a.timeoutMs)}</span> },
            { key: "dp", header: "Depends on", wrap: true, render: (a) => list([...a.dependsOn, ...a.softDependsOn.map((s) => `${s} (soft)`)]) },
            { key: "ri", header: "Required inputs", wrap: true, render: (a) => list(a.requiredInputs) }, { key: "oi", header: "Optional inputs", wrap: true, render: (a) => list(a.optionalInputs) },
          ]} />
          <h3 style={{ margin: "16px 0 6px" }}>Roles</h3>
          <DataTable wide caption="Research roles" rows={d.roles} rowKey={(r) => r.role} columns={[{ key: "r", header: "Role", render: (r) => <b>{upperWords(r.role)}</b> }, { key: "n", header: "Specification name", render: (r) => r.name }, { key: "k", header: "Kind", render: (r) => upperWords(r.kind) }, { key: "c", header: "Components", wrap: true, render: (r) => list(r.components) }]} />
        </>}
      </DataRegion>
    </Section>
  );
}
