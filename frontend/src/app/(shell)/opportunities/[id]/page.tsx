import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { serverSession } from "@/bff/handlers";
import { OpportunityDetail } from "@/components/desk/OpportunityDetail";
import { BlockedPanel } from "@/components/ScreenFoundation";
import { canView, findScreen } from "@/nav/registry";
import { UUID_PATTERN } from "@twins/api-contracts";

/** Screen 4, Opportunity Detail. It shares the Opportunities gate (shared intelligence: TRADER and ADMIN). The id is checked as a UUID before anything renders. */
export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const s = await serverSession((await headers()).get("cookie"));
  if (!("user" in s)) redirect("/login?expired=1");
  const screen = findScreen("/opportunities");
  if (!screen) notFound();
  if (!canView(s.user.role, screen)) return <BlockedPanel role={s.user.role} screen={screen} />;
  return <OpportunityDetail id={id} role={s.user.role} />;
}
