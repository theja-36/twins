import { createReadStream, createWriteStream } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Decrypter, Encrypter } from "age-encryption";

/**
 * Client-side encryption with age (https://age-encryption.org, X25519 recipients). Backups are encrypted with a PUBLIC recipient (`age1...`), so the
 * host that creates backups can never decrypt them. The private identity (`AGE-SECRET-KEY-1...`) is only ever read from a file by the restore side.
 * Standard `age -d -i key.txt backup.tar.age` also decrypts these files (recovery does not depend on this code).
 * Nothing here logs or returns key material or plaintext; errors are reduced to a fixed class.
 */
export class BackupCryptoError extends Error {
  constructor(readonly code: "bad_recipient" | "bad_identity" | "decrypt_failed" | "encrypt_failed") {
    super(code); // fixed text: never the underlying message
    this.name = "BackupCryptoError";
  }
}

const RECIPIENT = /^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$/;
export const isAgeRecipient = (s: string): boolean => RECIPIENT.test(s);

/** Short, non-secret identifier of a recipient for manifests (sha-256 prefix of the public recipient string). */
export async function recipientFingerprint(recipient: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recipient));
  return Buffer.from(digest).toString("hex").slice(0, 16);
}

const toWeb = (r: Readable): ReadableStream<Uint8Array> => Readable.toWeb(r) as unknown as ReadableStream<Uint8Array>;

async function writeStream(stream: ReadableStream<Uint8Array>, outPath: string): Promise<void> {
  const out = createWriteStream(outPath, { mode: 0o600 });
  await pipeline(Readable.fromWeb(stream as never), out as unknown as Writable);
  await chmod(outPath, 0o600);
}

export async function encryptFile(plainPath: string, outPath: string, recipient: string): Promise<void> {
  if (!isAgeRecipient(recipient)) throw new BackupCryptoError("bad_recipient");
  try {
    const enc = new Encrypter();
    enc.addRecipient(recipient);
    const cipher = await enc.encrypt(toWeb(createReadStream(plainPath)));
    await writeStream(cipher, outPath);
  } catch {
    throw new BackupCryptoError("encrypt_failed");
  }
}

/** Reads the identity from a file (the first `AGE-SECRET-KEY-1...` line; comments allowed, like `age-keygen` output). */
export async function readIdentity(identityFile: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(identityFile, "utf8");
  } catch {
    throw new BackupCryptoError("bad_identity");
  }
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(l));
  if (!line) throw new BackupCryptoError("bad_identity");
  return line;
}

export async function decryptFile(encPath: string, outPath: string, identityFile: string): Promise<void> {
  const identity = await readIdentity(identityFile);
  try {
    const dec = new Decrypter();
    dec.addIdentity(identity);
    const plain = await dec.decrypt(toWeb(createReadStream(encPath)));
    await writeStream(plain, outPath);
  } catch {
    throw new BackupCryptoError("decrypt_failed");
  }
}
