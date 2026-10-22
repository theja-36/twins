import type { UserCaptureChat, UserCaptureEntity, UserCaptureMedia, UserCaptureMessage, UserCaptureMethod } from "@twins/adapter-telegram";

/**
 * Strict validation of the internal capture payload. Hand-written on purpose: unknown fields are REJECTED (Fastify's default
 * schema validation silently strips them), every string and array is bounded, and problems are reported by path and rule
 * only - never with the offending value (it may be channel content).
 */
export const MAX_MESSAGES_PER_CALL = 100;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_ENTITIES = 500;
const MAX_PROBLEMS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PLAUSIBLE_UNIX = 1_000_000_000; // 2001-09-09
const MAX_FUTURE_SKEW_SECONDS = 24 * 3600;

export interface ImportBatchInfo {
  batchId: string;
  lowestMessageId: number;
  lowestMessageDate: number;
}

export interface ValidatedIngest {
  captureMethod: UserCaptureMethod;
  event: "message" | "delete";
  chat: UserCaptureChat;
  messages: UserCaptureMessage[];
  deletedMessageIds: number[];
  clientObservedAt?: string;
  importBatch?: ImportBatchInfo;
}

export type ValidationResult = { ok: true; value: ValidatedIngest } | { ok: false; problems: string[] };

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

class Problems {
  readonly list: string[] = [];
  add(path: string, rule: string): void {
    if (this.list.length < MAX_PROBLEMS) this.list.push(`${path}: ${rule}`);
  }
  get any(): boolean {
    return this.list.length > 0;
  }
}

function onlyKeys(obj: Rec, allowed: readonly string[], path: string, p: Problems): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) p.add(path, "unknown field");
}
function str(v: unknown, path: string, max: number, p: Problems, min = 0): string | undefined {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    p.add(path, `must be a string of ${min}-${max} characters`);
    return undefined;
  }
  return v;
}
function nonNegInt(v: unknown, path: string, p: Problems): number | undefined {
  if (!isInt(v) || v < 0) {
    p.add(path, "must be a non-negative integer");
    return undefined;
  }
  return v;
}

function validateEntities(v: unknown, path: string, p: Problems): UserCaptureEntity[] | undefined {
  if (!Array.isArray(v) || v.length > MAX_ENTITIES) {
    p.add(path, `must be an array of at most ${MAX_ENTITIES} items`);
    return undefined;
  }
  const out: UserCaptureEntity[] = [];
  v.forEach((item, i) => {
    const at = `${path}[${i}]`;
    if (!isRecord(item)) return p.add(at, "must be an object");
    onlyKeys(item, ["type", "offset", "length", "url", "language"], at, p);
    const type = str(item["type"], `${at}.type`, 40, p, 1);
    const offset = nonNegInt(item["offset"], `${at}.offset`, p);
    const length = nonNegInt(item["length"], `${at}.length`, p);
    const entity: UserCaptureEntity = { type: type ?? "", offset: offset ?? 0, length: length ?? 0 };
    if (item["url"] !== undefined) {
      const url = str(item["url"], `${at}.url`, 2048, p);
      if (url !== undefined) entity.url = url;
    }
    if (item["language"] !== undefined) {
      const language = str(item["language"], `${at}.language`, 40, p);
      if (language !== undefined) entity.language = language;
    }
    out.push(entity);
  });
  return out;
}

function validateMedia(v: unknown, path: string, p: Problems): UserCaptureMedia | undefined {
  if (!isRecord(v)) {
    p.add(path, "must be an object");
    return undefined;
  }
  onlyKeys(v, ["kind", "mime", "size", "duration", "width", "height", "fileUniqueId"], path, p);
  const media: UserCaptureMedia = { kind: str(v["kind"], `${path}.kind`, 40, p, 1) ?? "" };
  if (v["mime"] !== undefined) {
    const mime = str(v["mime"], `${path}.mime`, 100, p);
    if (mime !== undefined) media.mime = mime;
  }
  if (v["fileUniqueId"] !== undefined) {
    const id = str(v["fileUniqueId"], `${path}.fileUniqueId`, 100, p);
    if (id !== undefined) media.fileUniqueId = id;
  }
  for (const key of ["size", "duration", "width", "height"] as const) {
    if (v[key] !== undefined) {
      const n = nonNegInt(v[key], `${path}.${key}`, p);
      if (n !== undefined) media[key] = n;
    }
  }
  return media;
}

function validateMessage(v: unknown, path: string, nowSeconds: number, p: Problems): UserCaptureMessage | undefined {
  if (!isRecord(v)) {
    p.add(path, "must be an object");
    return undefined;
  }
  onlyKeys(v, ["id", "date", "editDate", "text", "entities", "media", "views", "forwards", "authorSignature", "hasProtectedContent"], path, p);
  if (!isInt(v["id"]) || v["id"] <= 0) p.add(`${path}.id`, "must be a positive integer");
  const date = v["date"];
  if (!isInt(date) || date < MIN_PLAUSIBLE_UNIX || date > nowSeconds + MAX_FUTURE_SKEW_SECONDS) p.add(`${path}.date`, "must be a plausible unix time in seconds");
  const message: UserCaptureMessage = { id: isInt(v["id"]) ? v["id"] : 0, date: isInt(date) ? date : 0 };
  if (v["editDate"] !== undefined) {
    const edit = v["editDate"];
    if (!isInt(edit) || edit < MIN_PLAUSIBLE_UNIX || edit > nowSeconds + MAX_FUTURE_SKEW_SECONDS || (isInt(date) && edit < date)) {
      p.add(`${path}.editDate`, "must be a plausible unix time not before date");
    } else {
      message.editDate = edit;
    }
  }
  if (v["text"] !== undefined) {
    const text = str(v["text"], `${path}.text`, MAX_TEXT_LENGTH, p);
    if (text !== undefined) message.text = text;
  }
  if (v["entities"] !== undefined) {
    const entities = validateEntities(v["entities"], `${path}.entities`, p);
    if (entities !== undefined) message.entities = entities;
  }
  if (v["media"] !== undefined) {
    const media = validateMedia(v["media"], `${path}.media`, p);
    if (media !== undefined) message.media = media;
  }
  for (const key of ["views", "forwards"] as const) {
    if (v[key] !== undefined) {
      const n = nonNegInt(v[key], `${path}.${key}`, p);
      if (n !== undefined) message[key] = n;
    }
  }
  if (v["authorSignature"] !== undefined) {
    const sig = str(v["authorSignature"], `${path}.authorSignature`, 128, p);
    if (sig !== undefined) message.authorSignature = sig;
  }
  if (v["hasProtectedContent"] !== undefined) {
    if (typeof v["hasProtectedContent"] !== "boolean") p.add(`${path}.hasProtectedContent`, "must be a boolean");
    else message.hasProtectedContent = v["hasProtectedContent"];
  }
  return message;
}

export function validateIngestBody(body: unknown, nowMs: number): ValidationResult {
  const p = new Problems();
  if (!isRecord(body)) return { ok: false, problems: ["body: must be a JSON object"] };
  onlyKeys(body, ["schemaVersion", "captureMethod", "event", "chat", "messages", "deletedMessageIds", "clientObservedAt", "importBatch"], "body", p);
  if (body["schemaVersion"] !== 1) p.add("schemaVersion", "must be 1");
  const method = body["captureMethod"];
  if (method !== "api_live" && method !== "api_history") p.add("captureMethod", "must be api_live or api_history");
  const event = body["event"];
  if (event !== "message" && event !== "delete") p.add("event", "must be message or delete");

  let chat: UserCaptureChat = { id: 0, type: "channel" };
  const rawChat = body["chat"];
  if (!isRecord(rawChat)) {
    p.add("chat", "must be an object");
  } else {
    onlyKeys(rawChat, ["id", "type", "title"], "chat", p);
    if (!isInt(rawChat["id"]) || rawChat["id"] === 0) p.add("chat.id", "must be a non-zero integer");
    if (rawChat["type"] !== "channel") p.add("chat.type", "must be channel");
    chat = { id: isInt(rawChat["id"]) ? rawChat["id"] : 0, type: "channel" };
    if (rawChat["title"] !== undefined) {
      const title = str(rawChat["title"], "chat.title", 200, p);
      if (title !== undefined) chat.title = title;
    }
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const messages: UserCaptureMessage[] = [];
  const deleted: number[] = [];
  if (event === "message") {
    if (body["deletedMessageIds"] !== undefined) p.add("deletedMessageIds", "is not allowed for event message");
    const list = body["messages"];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MESSAGES_PER_CALL) {
      p.add("messages", `must be an array of 1-${MAX_MESSAGES_PER_CALL} items`);
    } else {
      list.forEach((item, i) => {
        const message = validateMessage(item, `messages[${i}]`, nowSeconds, p);
        if (message) messages.push(message);
      });
    }
  } else if (event === "delete") {
    if (body["messages"] !== undefined) p.add("messages", "is not allowed for event delete");
    const list = body["deletedMessageIds"];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MESSAGES_PER_CALL) {
      p.add("deletedMessageIds", `must be an array of 1-${MAX_MESSAGES_PER_CALL} items`);
    } else {
      list.forEach((id, i) => {
        if (!isInt(id) || id <= 0) p.add(`deletedMessageIds[${i}]`, "must be a positive integer");
        else deleted.push(id);
      });
    }
  }

  let clientObservedAt: string | undefined;
  if (body["clientObservedAt"] !== undefined) {
    const text = str(body["clientObservedAt"], "clientObservedAt", 40, p);
    if (text !== undefined) {
      if (Number.isNaN(Date.parse(text))) p.add("clientObservedAt", "must be an ISO-8601 time");
      else clientObservedAt = text;
    }
  }

  let importBatch: ImportBatchInfo | undefined;
  const rawBatch = body["importBatch"];
  if (method === "api_history") {
    if (!isRecord(rawBatch)) {
      p.add("importBatch", "is required for api_history");
    } else {
      onlyKeys(rawBatch, ["batchId", "lowestMessageId", "lowestMessageDate"], "importBatch", p);
      const batchId = rawBatch["batchId"];
      if (typeof batchId !== "string" || !UUID.test(batchId)) p.add("importBatch.batchId", "must be a UUID");
      if (!isInt(rawBatch["lowestMessageId"]) || rawBatch["lowestMessageId"] <= 0) p.add("importBatch.lowestMessageId", "must be a positive integer");
      if (!isInt(rawBatch["lowestMessageDate"]) || rawBatch["lowestMessageDate"] < MIN_PLAUSIBLE_UNIX) p.add("importBatch.lowestMessageDate", "must be a plausible unix time");
      if (typeof batchId === "string" && isInt(rawBatch["lowestMessageId"]) && isInt(rawBatch["lowestMessageDate"])) {
        importBatch = { batchId: batchId.toLowerCase(), lowestMessageId: rawBatch["lowestMessageId"], lowestMessageDate: rawBatch["lowestMessageDate"] };
      }
    }
  } else if (rawBatch !== undefined) {
    p.add("importBatch", "is only allowed for api_history");
  }

  if (p.any || (method !== "api_live" && method !== "api_history") || (event !== "message" && event !== "delete")) {
    return { ok: false, problems: p.list.length > 0 ? p.list : ["body: invalid"] };
  }
  const value: ValidatedIngest = { captureMethod: method, event, chat, messages, deletedMessageIds: deleted };
  if (clientObservedAt !== undefined) value.clientObservedAt = clientObservedAt;
  if (importBatch !== undefined) value.importBatch = importBatch;
  return { ok: true, value };
}
