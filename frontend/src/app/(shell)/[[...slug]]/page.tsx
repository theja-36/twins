import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { serverSession } from "@/bff/handlers";
import { AccountPanel } from "@/components/AccountPanel";
import { AccountsPanel } from "@/components/AccountsPanel";
import { BlockedPanel, ScreenFoundation } from "@/components/ScreenFoundation";
import { canView, findScreen, landingFor } from "@/nav/registry";

export default async function ScreenPage({ params }: { params: Promise<{ slug?: string[] }> }) {
  const path = `/${((await params).slug ?? []).join("/")}`, screen = findScreen(path);
  if (!screen) notFound();
  const s = await serverSession((await headers()).get("cookie"));
  if (!("user" in s)) redirect("/login?expired=1");
  const role = s.user.role;
  // An ADMIN has no private permission, so the Overview is not theirs: send them to their own landing page. Any other mismatch shows an explicit panel.
  if (screen.path === "/" && role === "ADMIN") redirect(landingFor(role));
  if (!canView(role, screen)) return <BlockedPanel role={role} screen={screen} />;
  if (screen.path === "/account") return <AccountPanel user={s.user} />;
  return <ScreenFoundation screen={screen}>{screen.path === "/" ? <AccountsPanel /> : null}</ScreenFoundation>;
}
