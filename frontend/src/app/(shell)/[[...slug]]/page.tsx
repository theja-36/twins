import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { serverSession } from "@/bff/handlers";
import { AccountPanel } from "@/components/AccountPanel";
import { DecisionsScreen } from "@/components/decisions/DecisionsScreen";
import { PlaybooksScreen } from "@/components/strategies/PlaybooksScreen";
import { InsightsScreen } from "@/components/insights/InsightsScreen";
import { MarketScreen } from "@/components/desk/MarketScreen";
import { ResearchExplorer } from "@/components/research/ResearchExplorer";
import { OpportunitiesScreen } from "@/components/desk/OpportunitiesScreen";
import { OverviewScreen } from "@/components/desk/OverviewScreen";
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
  if (screen.path === "/") return <OverviewScreen user={s.user} />;
  if (screen.path === "/market") return <MarketScreen />;
  if (screen.path === "/insights") return <InsightsScreen />;
  if (screen.path === "/research") return <ResearchExplorer />;
  if (screen.path === "/decisions") return <DecisionsScreen />;
  if (screen.path === "/strategies") return <PlaybooksScreen role={role} />;
  if (screen.path === "/opportunities") return <OpportunitiesScreen />;
  return <ScreenFoundation screen={screen} />;
}
