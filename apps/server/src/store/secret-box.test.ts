import { expect, test } from "bun:test";
import { createSecretBox } from "./secret-box.ts";
import { SecretBoxError } from "./types.ts";

const key = () => crypto.getRandomValues(new Uint8Array(32));

test("round-trips a password", async () => {
  const box = await createSecretBox(key());
  expect(await box.open(await box.seal("s3cret ünïcode"))).toBe("s3cret ünïcode");
});

test("uses a fresh IV each time", async () => {
  const box = await createSecretBox(key());
  const a = await box.seal("same");
  const b = await box.seal("same");
  expect(a.iv.length).toBe(12);
  expect(a.iv).not.toEqual(b.iv);
  expect(a.cipher).not.toEqual(b.cipher);
});

test("rejects a tampered cipher", async () => {
  const box = await createSecretBox(key());
  const sealed = await box.seal("s3cret");
  sealed.cipher[0] = (sealed.cipher[0] ?? 0) ^ 0xff;
  await expect(box.open(sealed)).rejects.toBeInstanceOf(SecretBoxError);
});

test("rejects a different key", async () => {
  const sealed = await (await createSecretBox(key())).seal("s3cret");
  const other = await createSecretBox(key());
  await expect(other.open(sealed)).rejects.toBeInstanceOf(SecretBoxError);
});

test("rejects a short key", async () => {
  await expect(createSecretBox(new Uint8Array(16))).rejects.toBeInstanceOf(RangeError);
});
