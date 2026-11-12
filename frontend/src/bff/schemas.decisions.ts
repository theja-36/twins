/**
 * Stage 09.3B.4: STRICT relay schemas for the decision reads (GET /decisions, /decisions/:id, /decisions/:id/comparables), built on the shapes proven against REAL engine output
 * (schemas.verified093b.ts, tests/integration/api-contracts/realOutputShapes.test.ts). Rules: undeclared fields are stripped; a declared field that breaks the contract refuses the whole response (neutral 502);
 * money stays an exact decimal STRING; the OUTCOME is an opaque string (an eligibility verdict, never an approval) and is never merged with the WORKFLOW STATE; nothing here computes or defaults.
 */
import { z } from "zod";
import { WORKFLOW_STATES } from "@/lib/workflowStates";
import { Comparables, DecisionExplanation, PermittedSize, StopLossValidation } from "./schemas.verified093b";

const txt = (n = 400) => z.string().max(n), id = z.string().max(64), ts = z.string().max(40);
const Invalidated = z.object({ reasonCode: txt(80), at: ts }).nullable();
/** A history row: identity, the two separate vocabularies, validity window, invalidation and the headline only (the explanation body is not sent in a list). */
export const DecisionRow = z.object({
  id, accountId: id, candidateId: id, outcome: txt(60), workflowState: z.enum(WORKFLOW_STATES), validFrom: ts, validUntil: ts, createdAt: ts, invalidated: Invalidated, supersedesId: id.nullable(),
  explanation: z.object({ headline: txt(400) }),
});
export const DecisionListRelay = z.object({ decisions: z.array(DecisionRow).max(200) });
export const DecisionFull = z.object({
  id, accountId: id, candidateId: id, outcome: txt(60), workflowState: z.enum(WORKFLOW_STATES), explanation: DecisionExplanation, stopLossValidation: StopLossValidation.nullable(), permittedSize: PermittedSize.nullable(),
  evidenceRefs: z.array(txt(200)).max(500), versions: z.record(z.string(), txt(80)), validFrom: ts, validUntil: ts, supersedesId: id.nullable(), createdAt: ts, invalidated: Invalidated, simulationId: id.nullable(), riskAssessmentId: id.nullable(),
});
export const DecisionDetailRelay = z.object({
  decision: DecisionFull,
  events: z.array(z.object({ fromState: txt(40).nullable(), toState: txt(40), actor: txt(80), reason: txt(400).nullable(), at: ts })).max(200),
  approval: z.object({ action: txt(40), at: ts }).nullable(), watching: z.boolean(),
});
export const ComparablesRelay = z.object({ decisionId: id, comparables: Comparables });
export const DECISION_RELAY_SCHEMAS = { "decisions.list": DecisionListRelay, "decisions.get": DecisionDetailRelay, "decisions.comparables": ComparablesRelay } as const;
