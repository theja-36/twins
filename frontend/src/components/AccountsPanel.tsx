"use client";
import { useAccounts } from "@/api/hooks";
import { deriveState } from "@/state/dataState";
import { DataTable } from "@/ui/table";
import { ProvenanceBadge } from "@/ui/badges";
import { DataRegion } from "@/ui/state";
import { Panel } from "@/ui/primitives";

/** Real data through the BFF relay: the signed-in trader's accounts (GET /accounts), rendered in all its states. */
export function AccountsPanel() {
  const q = useAccounts(), rows = q.data?.accounts ?? [];
  const state = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: rows.length === 0, privateRoute: true });
  return (
    <Panel aria-labelledby="accounts-h">
      <h2 id="accounts-h" style={{ marginBottom: 10 }}>Your accounts</h2>
      <DataRegion state={state} what="accounts" emptyHint="No account is set up for you yet. An administrator or the operator creates it." onRetry={() => void q.refetch()}>
        <DataTable caption="Your accounts" rows={rows} rowKey={(r) => r.id} columns={[
          { key: "name", header: "Name", render: (r) => <b>{r.name}</b> },
          { key: "mode", header: "Mode", render: (r) => <ProvenanceBadge kind={r.tradingMode.toLowerCase() === "paper" ? "PAPER" : r.tradingMode.toUpperCase()} /> },
          { key: "ccy", header: "Currency", render: (r) => r.baseCurrency },
          { key: "act", header: "Active", render: (r) => (r.isActive ? "Yes" : "No") },
        ]} />
      </DataRegion>
    </Panel>
  );
}
