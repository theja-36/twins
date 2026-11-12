"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAccounts } from "@/api/hooks";
import { deriveState } from "@/state/dataState";

/** The account switcher (TRADER only). The chosen account lives in the URL (`?account=<uuid>`) and is passed as `accountId` where the backend requires it. One account is selected automatically. */
export function AccountSelector() {
  const q = useAccounts(), router = useRouter(), path = usePathname(), params = useSearchParams();
  const accounts = q.data?.accounts ?? [], state = deriveState({ loading: q.isLoading, error: q.error, hasData: !!q.data, empty: accounts.length === 0, privateRoute: true });
  const chosen = params.get("account") ?? accounts[0]?.id ?? "";
  if (state === "LOADING") return <span className="small muted" role="status">Loading accounts…</span>;
  if (state === "EMPTY") return <span className="small muted">No account</span>;
  if (state !== "READY" && state !== "STALE") return <span className="small muted" role="status">Accounts unavailable</span>;
  if (accounts.length === 1 && accounts[0]) return <span className="small tx2" data-testid="account-single">{accounts[0].name} <span className="src">{accounts[0].tradingMode.toUpperCase()}</span></span>;
  return (
    <div className="field" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <label htmlFor="account-select" className="small muted">Account</label>
      <select id="account-select" className="input" style={{ width: "auto", padding: "4px 8px" }} value={chosen} onChange={(e) => { const sp = new URLSearchParams(params.toString()); sp.set("account", e.target.value); router.replace(`${path}?${sp.toString()}`); }}>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </div>
  );
}
