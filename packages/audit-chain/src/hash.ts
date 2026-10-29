import { createHash } from "node:crypto";
import { GENESIS_HASH, HASH_DOMAIN } from "./specs";

export type PayloadField = string | null;

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Deterministic canonical payload: a JSON array of strings/null in the spec's fixed order. */
export function canonicalPayload(fields: readonly PayloadField[]): string {
  return JSON.stringify(fields);
}

export function computePayloadHash(fields: readonly PayloadField[]): string {
  return sha256Hex(canonicalPayload(fields));
}

export function computeEventHash(chain: string, chainIndex: number | bigint | string, previousHash: string, payloadHash: string): string {
  return sha256Hex([HASH_DOMAIN, chain, String(chainIndex), previousHash, payloadHash].join("\n"));
}

export { GENESIS_HASH };
