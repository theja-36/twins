import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, copyFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/**
 * The off-host object store seam. Production = S3-compatible (Cloudflare R2). `createDirStore` is a plain directory used by tests and local
 * rehearsal ONLY: it is not off-host and every report labels the provider so a directory can never be mistaken for off-host evidence.
 */
export interface StoredObject {
  key: string;
  bytes: number;
  lastModified: Date;
}
export interface ObjectStore {
  /** "s3" (real provider endpoint) or "dir" (local directory: NOT off-host). */
  readonly kind: "s3" | "dir";
  /** Human label that never contains credentials, e.g. the endpoint host and bucket. */
  readonly label: string;
  /** Upload a local file. Must refuse to overwrite an existing key. */
  putFile(key: string, path: string, meta: { sha256: string }): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  getFile(key: string, path: string): Promise<void>;
  getText(key: string): Promise<string>;
  head(key: string): Promise<{ bytes: number } | undefined>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
}

export class StoreError extends Error {
  constructor(readonly code: "exists" | "not_found" | "failed", readonly op: string) {
    super(`${op}: ${code}`); // never the provider's message (it can embed endpoints or request ids)
    this.name = "StoreError";
  }
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,300}$/;
function assertKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes("..") || key.includes("//")) throw new StoreError("failed", "key");
}

export function createDirStore(root: string): ObjectStore {
  const base = resolve(root);
  const path = (key: string): string => {
    assertKey(key);
    const p = resolve(base, key);
    if (!p.startsWith(base + sep)) throw new StoreError("failed", "key");
    return p;
  };
  return {
    kind: "dir",
    label: `dir:${base}`,
    async putFile(key, file) {
      const dest = path(key);
      if (await stat(dest).then(() => true, () => false)) throw new StoreError("exists", "put");
      await mkdir(dirname(dest), { recursive: true });
      const tmp = `${dest}.part`;
      await copyFile(file, tmp);
      await rename(tmp, dest);
    },
    async putText(key, text) {
      const dest = path(key);
      if (await stat(dest).then(() => true, () => false)) throw new StoreError("exists", "put");
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(Readable.from([Buffer.from(text, "utf8")]), createWriteStream(dest));
    },
    async getFile(key, file) {
      const src = path(key);
      if (!(await stat(src).then(() => true, () => false))) throw new StoreError("not_found", "get");
      await pipeline(createReadStream(src), createWriteStream(file, { mode: 0o600 }));
    },
    async getText(key) {
      const src = path(key);
      const chunks: Buffer[] = [];
      try {
        for await (const c of createReadStream(src)) chunks.push(c as Buffer);
      } catch {
        throw new StoreError("not_found", "get");
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    async head(key) {
      const s = await stat(path(key)).catch(() => undefined);
      return s ? { bytes: s.size } : undefined;
    },
    async list(prefix) {
      const out: StoredObject[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const p = join(dir, e.name);
          if (e.isDirectory()) await walk(p);
          else if (!e.name.endsWith(".part")) {
            const key = p.slice(base.length + 1).split(sep).join("/");
            if (key.startsWith(prefix)) {
              const s = await stat(p);
              out.push({ key, bytes: s.size, lastModified: s.mtime });
            }
          }
        }
      };
      await walk(base);
      return out.sort((a, b) => (a.key < b.key ? -1 : 1));
    },
    async delete(key) {
      await rm(path(key), { force: true });
    },
  };
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
}

/** S3-compatible store (Cloudflare R2, Backblaze B2, AWS S3, MinIO). Uploads are conditional (`If-None-Match: *`) so an existing key is never overwritten. */
export function createS3Store(config: S3Config, client?: S3Client): ObjectStore {
  const s3 =
    client ??
    new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? "auto",
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 4,
    });
  const host = new URL(config.endpoint).host;
  const wrap = async <T>(op: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.$metadata?.httpStatusCode === 412 || e.name === "PreconditionFailed") throw new StoreError("exists", op);
      if (e.$metadata?.httpStatusCode === 404 || e.name === "NoSuchKey" || e.name === "NotFound") throw new StoreError("not_found", op);
      throw new StoreError("failed", op);
    }
  };
  return {
    kind: "s3",
    label: `s3:${host}/${config.bucket}`,
    putFile: (key, file, meta) => {
      assertKey(key);
      return wrap("put", async () => {
        const size = (await stat(file)).size;
        await s3.send(
          new PutObjectCommand({
            Bucket: config.bucket, Key: key, Body: createReadStream(file), ContentLength: size,
            ContentType: "application/octet-stream", Metadata: { sha256: meta.sha256 }, IfNoneMatch: "*",
          }),
        );
      });
    },
    putText: (key, text) => {
      assertKey(key);
      return wrap("put", async () => {
        await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: text, ContentType: "application/json", IfNoneMatch: "*" }));
      });
    },
    getFile: (key, file) => {
      assertKey(key);
      return wrap("get", async () => {
        const res = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        await pipeline(res.Body as Readable, createWriteStream(file, { mode: 0o600 }));
      });
    },
    getText: (key) => {
      assertKey(key);
      return wrap("get", async () => {
        const res = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        return (await res.Body?.transformToString("utf8")) ?? "";
      });
    },
    head: (key) => {
      assertKey(key);
      return wrap("head", async () => {
        try {
          const res = await s3.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
          return { bytes: Number(res.ContentLength ?? 0) };
        } catch (error) {
          if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return undefined;
          throw error;
        }
      });
    },
    list: (prefix) =>
      wrap("list", async () => {
        const out: StoredObject[] = [];
        let token: string | undefined;
        do {
          const res = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }));
          for (const o of res.Contents ?? []) if (o.Key) out.push({ key: o.Key, bytes: Number(o.Size ?? 0), lastModified: o.LastModified ?? new Date(0) });
          token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        return out;
      }),
    delete: (key) => {
      assertKey(key);
      return wrap("delete", async () => {
        await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      });
    },
  };
}
