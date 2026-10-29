import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { describe, expect, it } from "vitest";
import { BackupCryptoError, decryptFile, encryptFile, isAgeRecipient, readIdentity, recipientFingerprint, sha256File, sha256Bytes } from "../../../packages/backup/src/index";
import { CANARY, keypair, tmp } from "./helpers";

describe("client-side age encryption", () => {
  it("round-trips a file byte-for-byte; the ciphertext is an age file and contains no plaintext", async () => {
    const dir = await tmp();
    const { recipient, identityFile } = await keypair(dir);
    const plain = join(dir, "plain.bin");
    const payload = Buffer.concat([Buffer.from(`${CANARY}\n`), Buffer.alloc(300_000, 7)]);
    await writeFile(plain, payload);
    await encryptFile(plain, join(dir, "x.age"), recipient);
    const cipher = await readFile(join(dir, "x.age"));
    expect(cipher.subarray(0, 21).toString("latin1")).toBe("age-encryption.org/v1");
    expect(cipher.includes(Buffer.from(CANARY))).toBe(false);
    await decryptFile(join(dir, "x.age"), join(dir, "back.bin"), identityFile);
    expect((await readFile(join(dir, "back.bin"))).equals(payload)).toBe(true);
    expect(await sha256File(join(dir, "back.bin"))).toBe(await sha256File(plain));
  });
  it("a wrong key cannot decrypt: fixed error code, no plaintext written, no key material in the error", async () => {
    const dir = await tmp();
    const a = await keypair(dir);
    const otherIdentity = await generateIdentity();
    const other = join(dir, "other.txt");
    await writeFile(other, `${otherIdentity}\n`);
    await writeFile(join(dir, "p"), CANARY);
    await encryptFile(join(dir, "p"), join(dir, "c.age"), a.recipient);
    const err = await decryptFile(join(dir, "c.age"), join(dir, "out"), other).then(() => undefined, (e: unknown) => e as BackupCryptoError);
    expect(err).toBeInstanceOf(BackupCryptoError);
    expect(err?.code).toBe("decrypt_failed");
    expect(`${err?.message}${err?.stack}`).not.toContain(otherIdentity);
    expect(`${err?.message}${err?.stack}`).not.toContain(CANARY);
  });
  it("a tampered ciphertext fails closed", async () => {
    const dir = await tmp();
    const { recipient, identityFile } = await keypair(dir);
    await writeFile(join(dir, "p"), Buffer.alloc(100_000, 1));
    await encryptFile(join(dir, "p"), join(dir, "c.age"), recipient);
    const c = await readFile(join(dir, "c.age"));
    c[c.length - 40] = (c[c.length - 40] ?? 0) ^ 0xff;
    await writeFile(join(dir, "c.age"), c);
    await expect(decryptFile(join(dir, "c.age"), join(dir, "o"), identityFile)).rejects.toMatchObject({ code: "decrypt_failed" });
  });
  it("refuses a private key or junk as the recipient, and an unreadable / malformed identity file", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "p"), "x");
    const priv = await generateIdentity();
    for (const bad of [priv, "age1short", "", "not-a-key"]) await expect(encryptFile(join(dir, "p"), join(dir, "o"), bad), bad.slice(0, 12)).rejects.toMatchObject({ code: "bad_recipient" });
    await expect(readIdentity(join(dir, "missing"))).rejects.toMatchObject({ code: "bad_identity" });
    await writeFile(join(dir, "junk"), "hello\n");
    await expect(readIdentity(join(dir, "junk"))).rejects.toMatchObject({ code: "bad_identity" });
  });
  it("recipient validation and fingerprint are non-secret and stable", async () => {
    const r = await identityToRecipient(await generateIdentity());
    expect(isAgeRecipient(r)).toBe(true);
    expect(await recipientFingerprint(r)).toMatch(/^[0-9a-f]{16}$/);
    expect(await recipientFingerprint(r)).toBe(await recipientFingerprint(r));
    expect(sha256Bytes("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
