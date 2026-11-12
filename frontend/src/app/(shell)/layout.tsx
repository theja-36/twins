import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { serverSession } from "@/bff/handlers";
import { Shell } from "@/components/Shell";
import { PlannedPanel } from "@/ui/state";

/**
 * Every signed-in page. The session is verified WITH THE BACKEND here (the middleware only checks that a cookie exists); a missing or rejected session goes to sign-in.
 * If the backend is unreachable the page says so instead of guessing who the user is.
 */
export default async function ShellLayout({ children }: { children: React.ReactNode }) {
  const s = await serverSession((await headers()).get("cookie"));
  if ("error" in s) {
    if (s.error === "UNAUTHENTICATED") redirect("/login?expired=1");
    return <main className="login" id="main"><div className="panel"><h1>TWINS</h1><PlannedPanel title="Service" kind="UNAVAILABLE">The service is not reachable right now. Nothing was changed. Please try again shortly.</PlannedPanel></div></main>;
  }
  return <Shell initialUser={s.user}>{children}</Shell>;
}
