/** Types of the research relay responses, derived from the strict relay schemas (type-only: no schema code reaches the browser bundle). */
import type { z } from "zod";
import type { AgentRegistryRelay, ResearchPackageAbsent, ResearchPackagePresent } from "@/bff/schemas.research";

export type ResearchPresent = z.infer<typeof ResearchPackagePresent>;
export type ResearchAbsent = z.infer<typeof ResearchPackageAbsent>;
export type ResearchResponse = ResearchPresent | ResearchAbsent;
export type AgentRegistry = z.infer<typeof AgentRegistryRelay>;
export type AgentReport = ResearchPresent["package"]["reports"][number];
