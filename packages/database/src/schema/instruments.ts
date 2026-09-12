import {
  boolean,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAtColumn, idColumn, updatedAtColumn } from "./_columns";

/**
 * A tradable instrument (equity, index, derivative, FX pair, commodity -
 * spec sections 12/14). Kept provider-agnostic: no broker-specific fields
 * are assumed here, only what the spec explicitly requires.
 */
export const instruments = pgTable(
  "instruments",
  {
    id: idColumn(),
    symbol: text("symbol").notNull(),
    exchange: text("exchange").notNull(),
    instrumentType: text("instrument_type").notNull(), // equity | index | future | option | fx | commodity
    name: text("name"),
    isin: text("isin"),
    currency: text("currency").notNull().default("INR"),
    lotSize: numeric("lot_size"),
    tickSize: numeric("tick_size"),
    isActive: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata"),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => ({
    exchangeSymbolUnique: uniqueIndex(
      "instruments_exchange_symbol_unique",
    ).on(table.exchange, table.symbol),
  }),
);
