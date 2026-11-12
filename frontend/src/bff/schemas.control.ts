/**
 * Stage 09.4: STRICT relay schemas for the paper-trading and portfolio reads, built from the REAL engine output proved by tests/integration/api-contracts/paperAndControlShapes.test.ts.
 * Rules: undeclared fields are STRIPPED. Deliberately NOT declared, so they never reach the browser: the position `userId`, the position `rules` object (fee schedule and management rules) and every position-event `payload`.
 * Money, quantities, prices and stops must be exact decimal STRINGS (a number, or text that is not a decimal, refuses the whole response with a neutral 502). A value the backend states as null stays null: nothing here computes, defaults or infers.
 */
import { z } from "zod";
import { PAPER_ORDER_STATES } from "@twins/api-contracts";

const txt = (n = 400) => z.string().max(n), id = z.string().max(64), ts = z.string().max(40);
const Dec = z.string().max(40).regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");
const DecNull = Dec.nullable();

export const PaperOrder = z.object({
  id, decisionId: id, accountId: id, positionId: id.nullable(), purpose: z.enum(["ENTRY", "EXIT"]), exitReason: txt(60).nullable(), instrument: txt(120), exchange: txt(20), side: z.enum(["BUY", "SELL"]), orderType: txt(30),
  quantity: Dec, limitPrice: DecNull, filledQuantity: Dec, avgFillPrice: DecNull, status: z.enum(PAPER_ORDER_STATES), stateReason: txt(400).nullable(), createdAt: ts,
});
export const OrdersRelay = z.object({ orders: z.array(PaperOrder).max(200) });
export const PaperFill = z.object({ id, quantity: Dec, price: Dec, costs: Dec, priceSource: txt(40), filledAt: ts });
export const FillsRelay = z.object({ fills: z.array(PaperFill).max(500) });
export const PaperPosition = z.object({
  id, accountId: id, decisionId: id, instrument: txt(120), exchange: txt(20), side: z.enum(["BUY", "SELL"]), quantity: Dec, initialQuantity: Dec, avgEntryPrice: Dec, initialStop: Dec, stopLoss: Dec, targets: z.array(Dec).max(20),
  realizedPnl: Dec, realizedCosts: Dec, status: z.enum(["OPEN", "CLOSED"]), exitReason: txt(60).nullable(), openedAt: ts, closedAt: ts.nullable(),
});
export const PositionsRelay = z.object({ positions: z.array(PaperPosition).max(200) });
export const PositionEvent = z.object({ kind: txt(60), at: ts });
export const PositionEventsRelay = z.object({ events: z.array(PositionEvent).max(500) });
export const PortfolioFacts = z.object({
  accountId: id, openPositions: z.number().int().nonnegative(), allocatedNotional: Dec, realizedPnl: Dec, totalCapital: DecNull, availableCapital: DecNull, unallocatedCapital: DecNull, capitalProfileVersion: z.number().int().nullable(),
});
export const PortfolioRelay = z.object({ accountId: id, mode: z.literal("PAPER"), isolation: z.literal("PER_USER_ACCOUNT"), facts: PortfolioFacts.nullable(), notes: z.array(txt(500)).max(20) });
export const CONTROL_RELAY_SCHEMAS = { "orders.list": OrdersRelay, "orders.fills": FillsRelay, "positions.list": PositionsRelay, "positions.events": PositionEventsRelay, "portfolio.get": PortfolioRelay } as const;
