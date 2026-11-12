import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { UUID_PATTERN } from "@twins/api-contracts";
import { serverSession } from "@/bff/handlers";
import { BlockedPanel } from "@/components/ScreenFoundation";
import { ResearchWorkspace } from "@/components/research/ResearchWorkspace";
import { canView, findScreen } from "@/nav/registry";

/** The Research Workspace for one candidate. It shares the Research gate (shared intelligence: TRADER and ADMIN, both holding research:read). The id is checked as a UUID before anything renders. */
export default async function ResearchWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const s = await serverSession((await headers()).get("cookie"));
  if (!("user" in s)) redirect("/login?expired=1");
  const screen = findScreen("/research");
  if (!screen) notFound();
  if (!canView(s.user.role, screen)) return <BlockedPanel role={s.user.role} screen={screen} />;
  return <ResearchWorkspace id={id} />;
}
