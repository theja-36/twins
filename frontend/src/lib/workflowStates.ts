/** Decision workflow states (packages/api-contracts DECISION_STATES). Plain constants, kept free of any schema library so the browser bundle never loads zod (zod probes eval, which the CSP refuses). */
export const WORKFLOW_STATES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "CANCELLED"] as const;
