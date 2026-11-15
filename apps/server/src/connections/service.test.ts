import { beforeEach, expect, test } from "bun:test";
import type { ConnectionInput } from "@dpilot/shared";
import { openStore } from "../store/database.ts";
import type { KeyStore } from "../store/types.ts";
import { createConnectionService } from "./service.ts";
import type { ConnectionService } from "./types.ts";

class MemoryKeyStore implements KeyStore {
  creates = 0;
  constructor(public key: Uint8Array | null = null) {}
  read() {
    return this.key;
  }
  create() {
    if (this.key) throw new Error("exists");
    this.creates++;
    this.key = crypto.getRandomValues(new Uint8Array(32));
    return this.key;
  }
}

const input: ConnectionInput = {
  label: "Prod",
  engine: "postgres",
  host: "db.example.com",
  port: 5432,
  username: "app",
  database: "app",
  tls: { mode: "require", ca: null },
};

let db: ReturnType<typeof openStore>;
let keys: MemoryKeyStore;
let changed: string[];
let ids: number;
let svc: ConnectionService;

function service(keyStore: KeyStore) {
  return createConnectionService({
    db,
    keys: keyStore,
    now: () => new Date("2026-11-15T00:00:00Z"),
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    onChanged: (id) => changed.push(id),
  });
}

beforeEach(() => {
  db = openStore(":memory:");
  keys = new MemoryKeyStore();
  changed = [];
  ids = 0;
  svc = service(keys);
});

test("creates and lists without exposing the password", async () => {
  const saved = await svc.create({ ...input, password: "s3cret" });
  expect(saved).toMatchObject({ hasPassword: true, passwordLost: false, label: "Prod" });
  expect(JSON.stringify(await svc.list())).not.toContain("s3cret");
  expect((await svc.resolve(saved.id)).password).toBe("s3cret");
});

test("stores the password encrypted", async () => {
  await svc.create({ ...input, password: "s3cret" });
  const row = db.query("SELECT password_cipher AS c FROM connections").get() as {
    c: Uint8Array;
  };
  expect(Buffer.from(row.c).includes(Buffer.from("s3cret"))).toBe(false);
});

test("saves a connection without a password", async () => {
  const saved = await svc.create(input);
  expect(saved.hasPassword).toBe(false);
  expect((await svc.resolve(saved.id)).password).toBeNull();
  expect(keys.creates).toBe(0);
});

test("keeps the password when a patch omits it", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  const updated = await svc.update(id, { label: "Renamed" });
  expect(updated.label).toBe("Renamed");
  expect((await svc.resolve(id)).password).toBe("s3cret");
});

test("clears the password when a patch sends null", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  expect((await svc.update(id, { password: null })).hasPassword).toBe(false);
  expect((await svc.resolve(id)).password).toBeNull();
});

test("rejects keeping the password when the host changes", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  await expect(svc.update(id, { host: "other.example.com" })).rejects.toMatchObject({
    code: "password_required",
  });
  await expect(svc.draft({ id, port: 6543 })).rejects.toMatchObject({
    code: "password_required",
  });
});

test("allows a host change with a new password", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  await svc.update(id, { host: "other.example.com", password: "n3w" });
  expect(await svc.resolve(id)).toMatchObject({ host: "other.example.com", password: "n3w" });
});

test("rejects a duplicate label", async () => {
  await svc.create(input);
  await expect(svc.create(input)).rejects.toMatchObject({ code: "label_taken" });
});

test("reports an unknown id as not found", async () => {
  await expect(svc.get("nope")).rejects.toMatchObject({ code: "not_found" });
  await expect(svc.remove("nope")).rejects.toMatchObject({ code: "not_found" });
});

test("flags passwords as lost when the key is missing", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  const later = service(new MemoryKeyStore());
  expect((await later.list())[0]).toMatchObject({ hasPassword: true, passwordLost: true });
  await expect(later.resolve(id)).rejects.toMatchObject({ code: "password_lost" });
});

test("does not touch a key that fails the check", async () => {
  await svc.create({ ...input, password: "s3cret" });
  const wrong = new MemoryKeyStore(crypto.getRandomValues(new Uint8Array(32)));
  const later = service(wrong);
  await expect(later.create({ ...input, label: "Other", password: "x" })).rejects.toMatchObject({
    code: "key_mismatch",
  });
  expect(wrong.creates).toBe(0);
});

test("creates a new key when none exists and marks old passwords lost", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  const fresh = new MemoryKeyStore();
  const later = service(fresh);
  const other = await later.create({ ...input, label: "Other", password: "x" });
  expect(fresh.creates).toBe(1);
  expect(await later.get(id)).toMatchObject({ hasPassword: false, passwordLost: true });
  expect((await later.resolve(other.id)).password).toBe("x");
});

test("concurrent password saves without a key keep both passwords", async () => {
  const [a, b] = await Promise.all([
    svc.create({ ...input, label: "A", password: "pa" }),
    svc.create({ ...input, label: "B", password: "pb" }),
  ]);
  expect(keys.creates).toBe(1);
  expect((await svc.resolve(a.id)).password).toBe("pa");
  expect((await svc.resolve(b.id)).password).toBe("pb");
});

test("re-entering a lost password clears the flag", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  const later = service(new MemoryKeyStore());
  const updated = await later.update(id, { password: "again" });
  expect(updated).toMatchObject({ hasPassword: true, passwordLost: false });
  expect((await later.resolve(id)).password).toBe("again");
});

test("notifies on update and remove", async () => {
  const { id } = await svc.create(input);
  await svc.update(id, { label: "B" });
  await svc.remove(id);
  expect(changed).toEqual([id, id]);
  expect(await svc.list()).toEqual([]);
});

test("draft without id returns the input as config", async () => {
  expect(await svc.draft({ ...input, password: "p" })).toEqual({
    engine: "postgres",
    host: "db.example.com",
    port: 5432,
    username: "app",
    password: "p",
    database: "app",
    tls: { mode: "require", ca: null },
  });
});

test("draft with id merges changes onto the saved connection", async () => {
  const { id } = await svc.create({ ...input, password: "s3cret" });
  expect(await svc.draft({ id, username: "other" })).toMatchObject({
    username: "other",
    password: "s3cret",
    host: "db.example.com",
  });
});
