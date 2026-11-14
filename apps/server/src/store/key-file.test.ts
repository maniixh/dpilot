import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileKeyStore } from "./key-file.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dpilot-key-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("returns null when there is no key", () => {
  expect(fileKeyStore(join(dir, "key")).read()).toBeNull();
});

test("creates a 32-byte key", () => {
  const path = join(dir, "sub", "key");
  const store = fileKeyStore(path);
  const created = store.create();
  expect(created.length).toBe(32);
  expect(store.read()).toEqual(created);
  if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("never overwrites an existing key file", () => {
  const path = join(dir, "key");
  const store = fileKeyStore(path);
  store.create();
  const before = readFileSync(path);
  expect(() => store.create()).toThrow();
  expect(readFileSync(path)).toEqual(before);
});

test("rejects a corrupt key file", () => {
  const path = join(dir, "key");
  writeFileSync(path, new Uint8Array(10));
  expect(() => fileKeyStore(path).read()).toThrow();
});
