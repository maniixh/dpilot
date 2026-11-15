import type { Database } from "bun:sqlite";
import {
  type ConnectionInput,
  type ConnectionPatch,
  type ConnectionTestRequest,
  engineIdSchema,
  type SavedConnection,
  tlsModeSchema,
} from "@dpilot/shared";
import { z } from "zod";
import { createSecretBox } from "../store/secret-box.ts";
import { type KeyStore, type Sealed, type SecretBox, SecretBoxError } from "../store/types.ts";
import { type ConnectionConfig, ConnectionError, type ConnectionService } from "./types.ts";

export interface ConnectionServiceDeps {
  db: Database;
  keys: KeyStore;
  now: () => Date;
  randomId: () => string;
  /** Called after a saved connection changes or is removed, so cached sessions can be dropped. */
  onChanged: (id: string) => void;
}

const KEY_CHECK = "key_check";
const KEY_CHECK_TEXT = "dpilot-key-check";
const IV_BYTES = 12;

const LOST_MESSAGE =
  "Dpilot can't read this connection's saved password. Edit the connection and enter it again.";
const MISMATCH_MESSAGE =
  "Dpilot's key file doesn't match its saved passwords. " +
  "Restore ~/.dpilot/key, or delete it to start over and re-enter passwords.";
const PASSWORD_REQUIRED_MESSAGE =
  "Enter the password again: Dpilot doesn't send a saved password to a different server.";

const bytes = z.instanceof(Uint8Array);

const rowSchema = z.object({
  id: z.string(),
  label: z.string(),
  engine: engineIdSchema,
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  password_cipher: bytes.nullable(),
  password_iv: bytes.nullable(),
  password_lost: z.union([z.literal(0), z.literal(1)]),
  database: z.string().nullable(),
  tls_mode: tlsModeSchema,
  tls_ca: z.string().nullable(),
  read_only: z.union([z.literal(0), z.literal(1)]),
  created_at: z.string(),
  updated_at: z.string(),
});
type Row = z.infer<typeof rowSchema>;

type KeyState = { kind: "usable"; box: SecretBox } | { kind: "missing" } | { kind: "mismatch" };

export function createConnectionService(deps: ConnectionServiceDeps): ConnectionService {
  const { db } = deps;

  function readCheck(): Sealed | null {
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(KEY_CHECK) as {
      value: Uint8Array;
    } | null;
    if (!row) return null;
    const value = new Uint8Array(row.value);
    return { iv: value.slice(0, IV_BYTES), cipher: value.slice(IV_BYTES) };
  }

  async function writeCheck(box: SecretBox): Promise<void> {
    const sealed = await box.seal(KEY_CHECK_TEXT);
    const value = new Uint8Array(sealed.iv.length + sealed.cipher.length);
    value.set(sealed.iv);
    value.set(sealed.cipher, sealed.iv.length);
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [KEY_CHECK, value]);
  }

  async function keyState(): Promise<KeyState> {
    let key: Uint8Array | null;
    try {
      key = deps.keys.read();
    } catch {
      return { kind: "mismatch" };
    }
    if (key === null) return { kind: "missing" };
    const box = await createSecretBox(key);
    const check = readCheck();
    if (check === null) return { kind: "usable", box };
    try {
      return (await box.open(check)) === KEY_CHECK_TEXT
        ? { kind: "usable", box }
        : { kind: "mismatch" };
    } catch {
      return { kind: "mismatch" };
    }
  }

  /** Encrypts a password, creating the key on first use. Never replaces an existing key file. */
  let sealing: Promise<unknown> = Promise.resolve();
  function seal(password: string): Promise<Sealed> {
    // One at a time: a key created by one call must not have its cleanup wipe another's password.
    const next = sealing.then(() => sealNow(password));
    sealing = next.catch(() => undefined);
    return next;
  }

  async function sealNow(password: string): Promise<Sealed> {
    const state = await keyState();
    if (state.kind === "mismatch") throw new ConnectionError("key_mismatch", MISMATCH_MESSAGE);
    if (state.kind === "usable") {
      if (readCheck() === null) await writeCheck(state.box);
      return state.box.seal(password);
    }
    const box = await createSecretBox(deps.keys.create());
    await writeCheck(box);
    // Passwords sealed with the previous (now missing) key can never be read again.
    db.run(
      `UPDATE connections SET password_cipher = NULL, password_iv = NULL, password_lost = 1
       WHERE password_cipher IS NOT NULL`,
    );
    return box.seal(password);
  }

  function parseRow(raw: unknown): Row | null {
    const parsed = rowSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const id = (raw as { id?: unknown } | null)?.id;
    console.warn(`Skipping an unreadable saved connection (id ${String(id)})`);
    return null;
  }

  function findRow(id: string): Row {
    const row = parseRow(db.query("SELECT * FROM connections WHERE id = ?").get(id) ?? null);
    if (!row) throw new ConnectionError("not_found", "No saved connection with that id.");
    return row;
  }

  function toSaved(row: Row, usable: boolean): SavedConnection {
    const hasPassword = row.password_cipher !== null;
    return {
      id: row.id,
      label: row.label,
      engine: row.engine,
      host: row.host,
      port: row.port,
      username: row.username,
      database: row.database,
      tls: { mode: row.tls_mode, ca: row.tls_ca },
      readOnly: row.read_only === 1,
      hasPassword,
      passwordLost: row.password_lost === 1 || (hasPassword && !usable),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function savedFor(row: Row): Promise<SavedConnection> {
    const state = row.password_cipher === null ? null : await keyState();
    return toSaved(row, state === null || state.kind === "usable");
  }

  async function storedPassword(row: Row): Promise<string | null> {
    if (row.password_cipher === null || row.password_iv === null) {
      if (row.password_lost === 1) throw new ConnectionError("password_lost", LOST_MESSAGE);
      return null;
    }
    const state = await keyState();
    if (state.kind !== "usable") throw new ConnectionError("password_lost", LOST_MESSAGE);
    try {
      return await state.box.open({ cipher: row.password_cipher, iv: row.password_iv });
    } catch (error) {
      if (error instanceof SecretBoxError) {
        throw new ConnectionError("password_lost", LOST_MESSAGE);
      }
      throw error;
    }
  }

  function movesServer(row: Row, patch: ConnectionPatch): boolean {
    return (
      (patch.engine !== undefined && patch.engine !== row.engine) ||
      (patch.host !== undefined && patch.host !== row.host) ||
      (patch.port !== undefined && patch.port !== row.port)
    );
  }

  function requirePasswordIfMoved(row: Row, patch: ConnectionPatch): void {
    if (patch.password === undefined && row.password_cipher !== null && movesServer(row, patch)) {
      throw new ConnectionError("password_required", PASSWORD_REQUIRED_MESSAGE);
    }
  }

  function translateWriteError(error: unknown, label: string): never {
    if (error instanceof Error && error.message.includes("connections.label")) {
      throw new ConnectionError("label_taken", `A connection named ${label} already exists.`);
    }
    throw error;
  }

  async function sealOrNull(password: string | null | undefined): Promise<Sealed | null> {
    return password === undefined || password === null ? null : seal(password);
  }

  return {
    async list() {
      const raw = db.query("SELECT * FROM connections ORDER BY label COLLATE NOCASE").all();
      const rows = raw.map(parseRow).filter((row): row is Row => row !== null);
      const needsKey = rows.some((row) => row.password_cipher !== null);
      const usable = !needsKey || (await keyState()).kind === "usable";
      return rows.map((row) => toSaved(row, usable));
    },

    async get(id) {
      return savedFor(findRow(id));
    },

    async create(input: ConnectionInput) {
      const sealed = await sealOrNull(input.password);
      const id = deps.randomId();
      const now = deps.now().toISOString();
      try {
        db.run(
          `INSERT INTO connections (id, label, engine, host, port, username, password_cipher,
             password_iv, password_lost, database, tls_mode, tls_ca, read_only, created_at,
             updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            input.label,
            input.engine,
            input.host,
            input.port,
            input.username,
            sealed?.cipher ?? null,
            sealed?.iv ?? null,
            input.database ?? null,
            input.tls.mode,
            input.tls.ca,
            input.readOnly ? 1 : 0,
            now,
            now,
          ],
        );
      } catch (error) {
        translateWriteError(error, input.label);
      }
      return savedFor(findRow(id));
    },

    async update(id, patch) {
      const row = findRow(id);
      requirePasswordIfMoved(row, patch);
      const sealed = await sealOrNull(patch.password);
      // Sealing may have created a new key and cleared old passwords; read the row again.
      const current = findRow(id);
      const keepPassword = patch.password === undefined;
      const label = patch.label ?? current.label;
      const tls = patch.tls ?? { mode: current.tls_mode, ca: current.tls_ca };
      try {
        db.run(
          `UPDATE connections SET label = ?, engine = ?, host = ?, port = ?, username = ?,
             password_cipher = ?, password_iv = ?, password_lost = ?, database = ?,
             tls_mode = ?, tls_ca = ?, read_only = ?, updated_at = ?
           WHERE id = ?`,
          [
            label,
            patch.engine ?? current.engine,
            patch.host ?? current.host,
            patch.port ?? current.port,
            patch.username ?? current.username,
            keepPassword ? current.password_cipher : (sealed?.cipher ?? null),
            keepPassword ? current.password_iv : (sealed?.iv ?? null),
            keepPassword ? current.password_lost : 0,
            patch.database === undefined ? current.database : patch.database,
            tls.mode,
            tls.ca,
            (patch.readOnly ?? current.read_only === 1) ? 1 : 0,
            deps.now().toISOString(),
            id,
          ],
        );
      } catch (error) {
        translateWriteError(error, label);
      }
      deps.onChanged(id);
      return savedFor(findRow(id));
    },

    async remove(id) {
      const result = db.run("DELETE FROM connections WHERE id = ?", [id]);
      if (result.changes === 0) {
        throw new ConnectionError("not_found", "No saved connection with that id.");
      }
      deps.onChanged(id);
    },

    async resolve(id) {
      const row = findRow(id);
      return {
        engine: row.engine,
        host: row.host,
        port: row.port,
        username: row.username,
        password: await storedPassword(row),
        database: row.database,
        tls: { mode: row.tls_mode, ca: row.tls_ca },
        readOnly: row.read_only === 1,
      };
    },

    async draft(request: ConnectionTestRequest): Promise<ConnectionConfig> {
      if (!("id" in request)) {
        return {
          engine: request.engine,
          host: request.host,
          port: request.port,
          username: request.username,
          password: request.password ?? null,
          database: request.database ?? null,
          tls: request.tls,
          readOnly: request.readOnly ?? false,
        };
      }
      const { id, ...patch } = request;
      const row = findRow(id);
      requirePasswordIfMoved(row, patch);
      return {
        engine: patch.engine ?? row.engine,
        host: patch.host ?? row.host,
        port: patch.port ?? row.port,
        username: patch.username ?? row.username,
        password: patch.password === undefined ? await storedPassword(row) : patch.password,
        database: patch.database === undefined ? row.database : patch.database,
        tls: patch.tls ?? { mode: row.tls_mode, ca: row.tls_ca },
        readOnly: patch.readOnly ?? row.read_only === 1,
      };
    },
  };
}
