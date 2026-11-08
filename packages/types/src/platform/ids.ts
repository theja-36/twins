/** Branded identifiers so a user id cannot be passed where an account id is expected. Purely a compile-time aid. */
export type Brand<T, B extends string> = T & { readonly __brand: B };
export type UserId = Brand<string, "UserId">;
export type AccountId = Brand<string, "AccountId">;
export type CandidateId = Brand<string, "CandidateId">;
export type DecisionId = Brand<string, "DecisionId">;
export type CorrelationId = Brand<string, "CorrelationId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
function brand<B extends string>(name: string) { return (v: string): Brand<string, B> => { if (!isUuid(v)) throw new TypeError(`${name} must be a UUID`); return v as Brand<string, B>; }; }
export const asUserId = brand<"UserId">("UserId");
export const asAccountId = brand<"AccountId">("AccountId");
export const asCandidateId = brand<"CandidateId">("CandidateId");
export const asDecisionId = brand<"DecisionId">("DecisionId");
export const asCorrelationId = brand<"CorrelationId">("CorrelationId");
