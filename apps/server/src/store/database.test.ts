import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openStore } from "./database.ts";

function userVersion(db: ReturnType<typeof openStore>): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

const insertRow = `INSERT INTO connections (id, label, engine, host, port, username, tls_mode,
  created_at, updated_at) VALUES (?, ?, ?, 'h', 5432, 'u', 'off', 't', 't')`;

test("migrates a new store to the latest version", () => {
  const db = openStore(":memory:");
  expect(userVersion(db)).toBe(MIGRATIONS.length);
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  expect(names.map((n) => n.name)).toEqual(expect.arrayContaining(["connections", "meta"]));
});

test("migrating twice is a no-op", () => {
  const db = openStore(":memory:");
  db.run(insertRow, ["1", "a", "postgres"]);
  migrate(db);
  expect(userVersion(db)).toBe(MIGRATIONS.length);
  expect(db.query("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 1 });
});

test("keeps data across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dpilot-store-"));
  try {
    const path = join(dir, "nested", "dpilot.db");
    const first = openStore(path);
    first.run(insertRow, ["1", "a", "postgres"]);
    first.close();
    const second = openStore(path);
    expect(second.query("SELECT label FROM connections").get()).toEqual({ label: "a" });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects an unknown engine", () => {
  const db = openStore(":memory:");
  expect(() => db.run(insertRow, ["1", "a", "oracle"])).toThrow();
});

test("rejects a cipher without an iv", () => {
  const db = openStore(":memory:");
  db.run(insertRow, ["1", "a", "postgres"]);
  expect(() => db.run("UPDATE connections SET password_cipher = x'00'")).toThrow();
});
