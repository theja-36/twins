import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { serverSession } from "@/bff/handlers";
import { landingFor } from "@/nav/registry";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const s = await serverSession((await headers()).get("cookie"));
  if ("user" in s) redirect(landingFor(s.user.role));
  const sp = await searchParams;
  return <LoginForm expired={sp.expired === "1"} />;
}
