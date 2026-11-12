/**
 * Zod schemas for what crosses the BFF: request bodies (strict: unknown keys are refused) and the upstream responses the BFF itself consumes or relays.
 * Response schemas STRIP undeclared fields, so only declared data reaches the browser. A relayed route with no verified schema yet passes through as "a JSON object"
 * (listed in docs/frontend/contracts-verification.md §4); each screen stage adds the schema for the routes it uses.
 */
import { z } from "zod";
import { APPROVAL_ERROR_CODES, PLATFORM_ERROR_CODES } from "@twins/api-contracts";

export const LoginBody = z.strictObject({ email: z.string().min(3).max(254), password: z.string().min(1).max(1024) });
export type LoginBody = z.infer<typeof LoginBody>;

export const PublicUser = z.object({ id: z.string().min(1).max(64), email: z.string().max(254), displayName: z.string().max(200).nullable(), role: z.enum(["TRADER", "ADMIN"]), isActive: z.boolean() });
export type PublicUser = z.infer<typeof PublicUser>;
export const MeResponse = z.object({ user: PublicUser });
export const UpstreamLogin = z.object({ token: z.string().regex(/^tws_[A-Za-z0-9_-]{43}$/), expiresAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), "expiresAt must be a timestamp"), user: PublicUser });

export const AccountsResponse = z.object({ accounts: z.array(z.object({ id: z.string(), name: z.string(), tradingMode: z.string(), baseCurrency: z.string(), isActive: z.boolean() })).max(500) });

const ERROR_CODES = [...PLATFORM_ERROR_CODES, ...APPROVAL_ERROR_CODES] as [string, ...string[]];
/** Platform and approval error bodies: fixed fields only. */
export const UpstreamError = z.object({ error: z.enum(ERROR_CODES), message: z.string().max(300), reasons: z.array(z.string().max(200)).max(50).default([]), state: z.string().max(40).optional() });
const AnyJsonObject = z.record(z.string(), z.unknown());

/** Relay response schema per catalogue route id. Absent = pass-through JSON object (no verified schema yet). */
export const RELAY_RESPONSE_SCHEMAS: Readonly<Record<string, z.ZodType | undefined>> = { "accounts.list": AccountsResponse };
export const relaySchemaFor = (routeId: string): z.ZodType => RELAY_RESPONSE_SCHEMAS[routeId] ?? AnyJsonObject;
export const hasVerifiedSchema = (routeId: string): boolean => RELAY_RESPONSE_SCHEMAS[routeId] !== undefined;
