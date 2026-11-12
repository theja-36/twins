import { me } from "@/bff/handlers";
export const dynamic = "force-dynamic";
export const GET = (req: Request) => me(req);
