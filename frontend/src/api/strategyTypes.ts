/** Types of the decision and playbook relay responses, derived from the strict relay schemas (type-only: no schema code reaches the browser bundle). */
import type { z } from "zod";
import type { ComparablesRelay, DecisionDetailRelay, DecisionListRelay } from "@/bff/schemas.decisions";
import type { PlaybookDetailRelay, PlaybooksRelay } from "@/bff/schemas.strategies";

export type DecisionList = z.infer<typeof DecisionListRelay>;
export type DecisionRowT = DecisionList["decisions"][number];
export type DecisionDetail = z.infer<typeof DecisionDetailRelay>;
export type ComparablesResponse = z.infer<typeof ComparablesRelay>;
export type PlaybookList = z.infer<typeof PlaybooksRelay>;
export type PlaybookSummaryT = PlaybookList["playbooks"][number];
export type PlaybookDetail = z.infer<typeof PlaybookDetailRelay>;
