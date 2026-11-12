// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/api/hooks";
import { USER, ADMIN } from "@/test/helpers";
import { UserCacheGuard } from "./Providers";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh: vi.fn() }) }));
afterEach(() => { cleanup(); replace.mockReset(); vi.unstubAllGlobals(); });

describe("per-user cache isolation", () => {
  it("everything cached for the previous user is dropped the moment the signed-in user changes", () => {
    const qc = new QueryClient(); qc.setQueryData(["accounts"], { accounts: [{ id: "private-to-user-1" }] });
    const view = (id: string | null) => <QueryClientProvider client={qc}><UserCacheGuard userId={id} /></QueryClientProvider>;
    const { rerender } = render(view("u-1")); expect(qc.getQueryData(["accounts"])).toBeDefined(); // same user: kept
    rerender(view("u-1")); expect(qc.getQueryData(["accounts"])).toBeDefined();
    rerender(view("u-2")); expect(qc.getQueryData(["accounts"])).toBeUndefined(); // a different user: nothing of u-1's survives
  });
  it("the cache is also dropped when the session ends (user becomes null)", () => {
    const qc = new QueryClient(); qc.setQueryData(["approvals"], { pending: [] });
    const view = (id: string | null) => <QueryClientProvider client={qc}><UserCacheGuard userId={id} /></QueryClientProvider>;
    const { rerender } = render(view("u-1")); rerender(view(null)); expect(qc.getQueryData(["approvals"])).toBeUndefined();
  });
});

function Probe({ initial }: { initial: typeof USER }) { const u = useSession(initial); return <span data-testid="who">{u.email}</span>; }
describe("session expiry in the browser", () => {
  it("a 401 from the session probe clears every cached query and returns the user to sign-in with the expiry notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "UNAUTHENTICATED", message: "authentication required" }), { status: 401, headers: { "content-type": "application/json" } })));
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 0 } } }); qc.setQueryData(["accounts"], { accounts: [{ id: "x" }] });
    render(<QueryClientProvider client={qc}><Probe initial={USER} /></QueryClientProvider>);
    await act(async () => { await qc.refetchQueries({ queryKey: ["me"] }); });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?expired=1")); expect(qc.getQueryData(["accounts"])).toBeUndefined();
  });
  it("a healthy probe keeps the session and shows the user the server returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ user: ADMIN }), { status: 200, headers: { "content-type": "application/json" } })));
    const qc = new QueryClient(); const { getByTestId } = render(<QueryClientProvider client={qc}><Probe initial={USER} /></QueryClientProvider>);
    await act(async () => { await qc.refetchQueries({ queryKey: ["me"] }); }); await waitFor(() => expect(getByTestId("who").textContent).toBe(ADMIN.email)); expect(replace).not.toHaveBeenCalled();
  });
});
