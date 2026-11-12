/** Types of the analytics relay responses, derived from the strict relay schemas (type-only: no schema code reaches the browser bundle). */
import type { z } from "zod";
import type { ANALYTICS_RELAY_SCHEMAS } from "@/bff/schemas.insights";

type Env<K extends keyof typeof ANALYTICS_RELAY_SCHEMAS> = z.infer<(typeof ANALYTICS_RELAY_SCHEMAS)[K]>;
export type OverviewEnv = Env<"analytics.overview">;
export type StrategiesEnv = Env<"analytics.strategies">;
export type ChannelsEnv = Env<"analytics.channels">;
export type IndependentEnv = Env<"analytics.independent">;
export type AgentsEnv = Env<"analytics.agents">;
export type DecisionsEnv = Env<"analytics.decisions">;
export type DriftEnv = Env<"analytics.drift">;
export type DataQualityEnv = Env<"analytics.data-quality">;
export type CalibrationEnv = Env<"analytics.calibration">;
export type OutcomesEnv = Env<"analytics.outcomes">;
export type InsightsEnv = Env<"analytics.insights">;
export type AnyEnv = Pick<OverviewEnv, "contractVersion" | "generatedAt" | "dataset" | "mode" | "liveStatus" | "notice" | "snapshot" | "freshness" | "state">;
export type Metrics = NonNullable<OverviewEnv["data"]["all"]>;
export type OutcomeRowData = OutcomesEnv["data"][number];
export type InsightRowData = InsightsEnv["data"][number];
