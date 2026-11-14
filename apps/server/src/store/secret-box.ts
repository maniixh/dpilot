import { type Sealed, type SecretBox, SecretBoxError } from "./types.ts";

const IV_BYTES = 12;

/** AES-256-GCM with a fresh random IV per seal. */
export async function createSecretBox(key: Uint8Array): Promise<SecretBox> {
  if (key.length !== 32) throw new RangeError("The key must be 32 bytes");
  const cryptoKey = await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return {
    async seal(plain: string): Promise<Sealed> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const data = new TextEncoder().encode(plain);
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, data);
      return { cipher: new Uint8Array(cipher), iv };
    },
    async open(sealed: Sealed): Promise<string> {
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: new Uint8Array(sealed.iv) },
          cryptoKey,
          new Uint8Array(sealed.cipher),
        );
        return new TextDecoder().decode(plain);
      } catch {
        throw new SecretBoxError();
      }
    },
  };
}
