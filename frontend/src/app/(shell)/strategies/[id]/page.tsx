import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { UUID_PATTERN } from "@twins/api-contracts";
import { serverSession } from "@/bff/handlers";
import { BlockedPanel } from "@/components/ScreenFoundation";
import { PlaybookDetail } from "@/components/strategies/PlaybookDetail";
import { canView, findScreen } from "@/nav/registry";

/** One playbook (shared intelligence: TRADER and ADMIN). It shares the list screen's gate; the id is checked as a UUID before anything renders. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const s = await serverSession((await headers()).get("cookie"));
  if (!("user" in s)) redirect("/login?expired=1");
  const screen = findScreen("/strategies");
  if (!screen) notFound();
  if (!canView(s.user.role, screen)) return <BlockedPanel role={s.user.role} screen={screen} />;
  return <PlaybookDetail id={id} />;
}
