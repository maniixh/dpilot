import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Append-only: each entry upgrades the store by one version. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
   CREATE TABLE connections (
     id TEXT PRIMARY KEY,
     label TEXT NOT NULL UNIQUE,
     engine TEXT NOT NULL CHECK (engine IN ('mysql', 'mariadb', 'postgres')),
     host TEXT NOT NULL,
     port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
     username TEXT NOT NULL,
     password_cipher BLOB,
     password_iv BLOB,
     password_lost INTEGER NOT NULL DEFAULT 0 CHECK (password_lost IN (0, 1)),
     database TEXT,
     tls_mode TEXT NOT NULL CHECK (tls_mode IN ('off', 'require', 'verify')),
     tls_ca TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK ((password_cipher IS NULL) = (password_iv IS NULL))
   );`,
];

export function openStore(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  if (current >= MIGRATIONS.length) return;
  db.transaction(() => {
    for (const sql of MIGRATIONS.slice(current)) db.run(sql);
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`);
  })();
}
