import { logout } from "@/bff/handlers";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => logout(req);
