/**
 * Stage 09.3B.4: STRICT relay schemas for the two playbook reads (GET /intelligence/playbooks, /intelligence/playbooks/:id), from the verified backend playbook read views (proved key-for-key by
 * tests/unit/api-contracts/playbookParity.test.ts). A version's `content` and `performance` are JSON of UNVERIFIED shape: they are NOT declared here, so they never reach the browser. Counts, states and dates only.
 */
import { z } from "zod";

const txt = (n = 400) => z.string().max(n), id = z.string().max(64), ts = z.string().max(40);
export const PLAYBOOK_STATES = ["DRAFT", "EVALUATING", "ACTIVE", "RETIRED", "ROLLED_BACK"] as const;
export const PlaybookSummary = z.object({ id, sourceKind: txt(40), telegramSourceId: id.nullable(), name: txt(200), createdAt: ts, versions: z.number(), activeVersion: z.number().nullable(), latestVersion: z.number().nullable() });
export const PlaybooksRelay = z.object({ state: z.enum(["EMPTY", "OK"]), playbooks: z.array(PlaybookSummary).max(200) });
export const PlaybookVersion = z.object({
  version: z.number(), state: z.enum(PLAYBOOK_STATES), sampleSize: z.number(), confidence: z.number().nullable(), limitations: txt(2000), createdAt: ts, updatedAt: ts, influencesLive: z.boolean().nullable(), activatedAt: ts.nullable(),
  events: z.array(z.object({ fromState: txt(40).nullable(), toState: txt(40), actor: txt(80), reason: txt(400).nullable(), at: ts })).max(200),
});
export const PlaybookDetailRelay = z.object({
  playbook: PlaybookSummary, versions: z.array(PlaybookVersion).max(200),
  drift: z.array(z.object({ version: z.number(), kind: txt(60), metric: txt(80), baseline: z.number(), observed: z.number(), detectedAt: ts })).max(100), note: txt(500),
});
export const STRATEGY_RELAY_SCHEMAS = { "intelligence.playbooks": PlaybooksRelay, "intelligence.playbook": PlaybookDetailRelay } as const;
