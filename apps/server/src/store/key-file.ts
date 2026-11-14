import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyStore } from "./types.ts";

const KEY_BYTES = 32;

export function fileKeyStore(path: string): KeyStore {
  return {
    read() {
      if (!existsSync(path)) return null;
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.length !== KEY_BYTES) {
        throw new Error(`The key file ${path} is not a valid Dpilot key`);
      }
      return bytes;
    },
    create() {
      mkdirSync(dirname(path), { recursive: true });
      const key = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
      // "wx" fails when the file exists, so an existing key is never replaced.
      writeFileSync(path, key, { flag: "wx", mode: 0o600 });
      return key;
    },
  };
}
