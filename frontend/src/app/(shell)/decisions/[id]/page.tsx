import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { UUID_PATTERN } from "@twins/api-contracts";
import { serverSession } from "@/bff/handlers";
import { BlockedPanel } from "@/components/ScreenFoundation";
import { DecisionDetail } from "@/components/decisions/DecisionDetail";
import { canView, findScreen } from "@/nav/registry";

/** One decision (private to its owner; an ADMIN is blocked by the Decision History gate). It shares the list screen's gate; the id is checked as a UUID before anything renders. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const s = await serverSession((await headers()).get("cookie"));
  if (!("user" in s)) redirect("/login?expired=1");
  const screen = findScreen("/decisions");
  if (!screen) notFound();
  if (!canView(s.user.role, screen)) return <BlockedPanel role={s.user.role} screen={screen} />;
  return <DecisionDetail id={id} />;
}
