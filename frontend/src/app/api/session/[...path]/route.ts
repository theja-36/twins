import { relay } from "@/bff/handlers";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (req: Request, ctx: Ctx) => relay(req, (await ctx.params).path);
// Only GET is relayed; every other method answers 405 from the handler (the write actions arrive with their screens in Stage 09.3).
export const GET = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
