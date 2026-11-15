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
  `ALTER TABLE connections ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0
     CHECK (read_only IN (0, 1));
   CREATE TABLE query_history (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     target TEXT NOT NULL,
     database TEXT,
     sql TEXT NOT NULL,
     started_at TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'cancelled')),
     statements INTEGER NOT NULL,
     rows_affected INTEGER NOT NULL,
     error TEXT
   );
   CREATE INDEX query_history_target ON query_history (target, id DESC);
   CREATE TABLE saved_queries (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
     target TEXT,
     database TEXT,
     sql TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
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
