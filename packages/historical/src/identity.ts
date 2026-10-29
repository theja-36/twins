import { createHash } from "node:crypto";

/**
 * Stable identities (Stage 4 / Task 1). The IDENTITY of one message VERSION is sha256("hist-v1" | channel | message id | message timestamp (UTC ISO) | content hash), where the
 * content hash is over the REDACTED text. The same message delivered twice (same channel, id, time, text) therefore has the same identity wherever and whenever it is imported;
 * an edit has a different content hash and so a different identity. The message KEY (channel | id) groups the versions of one message.
 */
export const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export const messageKey = (channel: string, messageId: string): string => `${channel}|${messageId}`;
export const contentSha256 = (redactedText: string): string => sha256(redactedText);
export const identityKey = (channel: string, messageId: string, timestamp: Date, contentHash: string): string => sha256(`hist-v1|${channel}|${messageId}|${timestamp.toISOString()}|${contentHash}`);
