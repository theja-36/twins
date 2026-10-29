-- Stage 3 / Task 3: an APPROVED_FOR_REVIEW decision must carry a passing portfolio evaluation (NULL counts as not evaluated). NOT VALID: enforced for every
-- new row; rows written before this migration (none in staging; only test databases) are preserved untouched, never rewritten.
ALTER TABLE "risk_decisions" ADD CONSTRAINT "risk_decisions_portfolio_review_check" CHECK ("risk_decisions"."status" <> 'APPROVED_FOR_REVIEW' or coalesce("risk_decisions"."output_snapshot" -> 'portfolio' ->> 'outcome' = 'APPROVED_FOR_REVIEW', false)) NOT VALID;
