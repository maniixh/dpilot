export interface Sealed {
  cipher: Uint8Array;
  iv: Uint8Array;
}

export interface SecretBox {
  seal(plain: string): Promise<Sealed>;
  /** Throws SecretBoxError when the data was not sealed with this key or was altered. */
  open(sealed: Sealed): Promise<string>;
}

export class SecretBoxError extends Error {
  constructor(message = "The data couldn't be decrypted with this key") {
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface KeyStore {
  /** Null when no key exists yet; throws when one exists but is unusable. */
  read(): Uint8Array | null;
  /** Creates a new key; throws if one already exists. */
  create(): Uint8Array;
}
