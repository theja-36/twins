/** Types of the paper-trading and portfolio relay responses, derived from the strict relay schemas (type-only: no schema code reaches the browser bundle). */
import type { z } from "zod";
import type { FillsRelay, OrdersRelay, PortfolioRelay, PositionEventsRelay, PositionsRelay } from "@/bff/schemas.control";

export type OrdersResponse = z.infer<typeof OrdersRelay>;
export type PaperOrderT = OrdersResponse["orders"][number];
export type FillsResponse = z.infer<typeof FillsRelay>;
export type PaperPositionT = z.infer<typeof PositionsRelay>["positions"][number];
export type PositionsResponse = z.infer<typeof PositionsRelay>;
export type PositionEventsResponse = z.infer<typeof PositionEventsRelay>;
export type PortfolioResponse = z.infer<typeof PortfolioRelay>;
