import { login } from "@/bff/handlers";
export const dynamic = "force-dynamic";
export const POST = (req: Request) => login(req);
