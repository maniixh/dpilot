# M2 — Connections & explorer: design

Status: draft, awaiting approval. Roadmap source: `docs/PLAN.md` §5–§8, milestone M2.

## Intent

After M1, Dpilot can start database servers but cannot look inside one. M2 makes Dpilot a place
you open a server in: connect to the servers Dpilot runs and to servers it didn't create, see what
is inside them (databases, schemas, tables, views, routines) in a sidebar tree, and read the
server's details and variables. Every later milestone (data grid, SQL editor, schema designer,
import/export) hangs off the connection and the tree built here.

Done when: you can connect to a Dpilot server and to an external server, test a saved connection,
expand both in the sidebar down to tables, and read each server's info and variables.

## Goals

- Saved connections to external MySQL, MariaDB and PostgreSQL servers (host, port, user,
  password, optional default database), including cloud databases that require TLS.
- Test a connection before saving it, and test a saved one.
- Dpilot's own servers appear in the same tree with no extra step.
- Sidebar tree: server → databases → (Postgres: schemas →) tables, views, procedures, functions.
- Server overview: engine, version, user, uptime, encoding/charset, time zone; server variables
  with search.
- Passwords stored encrypted on disk and never sent back to the browser for saved connections.

## Non-goals (later milestones)

- Opening a table, browsing rows, running SQL (M3). Tables in the tree are names only.
- Editing variables or database settings, creating or dropping databases (M4/M7).
- SQLite file connections (M3, where browsing first needs them), MongoDB and Redis (M8).
- SSH tunnels. TLS covers cloud providers; SSH needs a new dependency and key handling and is
  deferred until asked for.
- Read-only connection mode (comes with data editing in M3).
- Query history and saved queries tables in the store (M3).

## Anti-goals

- A password written to disk in plain text, logged, or returned by `GET /connections`.
- A tree that loads everything up front: large servers must stay fast; each level loads on expand.
- Repeating M1's confusion: system databases (`mysql`, `sys`, `template0`…) must be visibly
  separate from the user's own.
- Two copies of a Dpilot server's credentials that can drift apart.

## Constraints

- Strict types, Zod at every boundary (request bodies, stored rows read back, driver rows).
- `app.ts` is type-imported by the web app: nothing it imports may use `node:*` or Bun globals.
  Store, crypto and driver code are injected as interfaces, like the Docker client today.
- The server binds 127.0.0.1 and requires the session cookie; M2 routes sit behind it.
- Identifiers are never interpolated; catalog queries use parameters only.
- Bun.SQL is the driver (verified against MySQL 8.4 and Postgres 17 in M1; supports TLS modes and
  a custom CA).
- Single binary: `bun:sqlite` is built in; no native modules.

## Approaches considered

**How Dpilot servers become connections**

1. *Store a connection row per Dpilot server* (what PLAN.md sketched: "instances auto-create
   one"). One code path for the tree, but the row must be created, updated and deleted in step
   with Docker; a server removed outside Dpilot leaves a stale row, and the password exists twice.
2. *Two sources, one list* — **chosen.** Dpilot servers stay live from Docker (credentials read
   from the container, as M1 does); the store holds only external connections. A small "targets"
   layer merges both into one list with distinct ids. No sync, no duplicate secret, and a server
   removed in Docker simply disappears.

**Where database access runs**

The browser cannot speak MySQL or Postgres, so the Bun server holds the connections and the web
app calls `/api/c/:target/...` (PLAN.md §6). The only choice is pooling: one Bun.SQL pool per
target (and per database on Postgres, below), small (`max: 2`), closed after 60 s idle. Opening a
fresh connection per request was rejected: TLS handshakes to cloud hosts would make every tree
expand slow.

**External reach** (decided without the user, see Calls): plain host/port/user/password plus TLS.
SSH tunnel deferred.

## Design

### Targets and ids

A target is anything the explorer can open:

- `s.<server-name>` — a Dpilot server (from Docker labels; credentials from container env).
- `c.<uuid>` — a saved connection (from the store).

`GET /api/targets` returns both, Dpilot servers first, each with `id`, `label`, `engine`, `kind`
(`server` | `connection`), and `available` (false for a stopped or still-provisioning Dpilot
server, with the reason). The id format is parsed by one Zod schema in `packages/shared`.

Saved connections never depend on Docker. When Docker is unreachable, `/api/targets` still returns
200 with the saved connections and `servers: { status: "unavailable", message }` in place of the
Dpilot server list; the sidebar shows that line and keeps the connections usable. (Call.)

### Local store

- File `~/.dpilot/dpilot.db` (`bun:sqlite`, WAL). Data dir resolved once in `run.ts` and injected;
  tests use a temp dir or `:memory:`.
- Migrations: ordered list of SQL steps; `PRAGMA user_version` records the applied count. M2 adds
  migration 1: table `connections` (id TEXT PK, label TEXT UNIQUE NOT NULL, engine, host, port,
  username, password_cipher BLOB NULL, password_iv BLOB NULL, database TEXT NULL, tls_mode, tls_ca
  TEXT NULL, created_at, updated_at) with CHECK constraints on engine and tls_mode.
- Rows read back go through a Zod schema; a row that fails is reported, not crashed on.

### Secrets

- AES-256-GCM via WebCrypto. Key: 32 random bytes in `~/.dpilot/key`, created on first use with
  mode 0600 (on Windows the file inherits the user-profile ACL; documented).
- Fresh 12-byte IV per encryption. Labels and hosts are not secret and stay plain.
- Wrong-key detection: the store keeps a key check (a fixed plaintext encrypted with the key) in a
  `meta` table. On open, the key decrypts the check or it is treated as lost.
- An existing key file is never overwritten or deleted. If the key is missing or fails the check,
  connections with stored passwords load with `passwordLost: true` and the UI asks for the password
  again instead of failing the whole list. Restoring the old key file brings them back. Only when
  the user next saves a password does Dpilot create a new key, write a new check, and clear the
  ciphertexts the new key cannot read (those rows keep `passwordLost` until re-entered). (Call.)
- API: saved connections return `hasPassword: boolean`, never the password. On edit, an omitted
  password keeps the stored one; an explicit `null` clears it.
- A stored password never follows the connection to a different server: if an edit (PATCH or
  `{ id, ...changes }` test) changes engine, host or port and omits the password, the request is
  rejected with 400 `password_required`, and the form asks for it. (Call.)

### Connection profile

```ts
type TlsMode = "off" | "require" | "verify"; // → Bun.SQL tls: "disable" | "require" | "verify-full"
interface ConnectionInput {
  label: string;            // 1–64 chars, unique
  engine: "mysql" | "mariadb" | "postgres";
  host: string;             // hostname or IP, no scheme, no spaces
  port: number;             // 1–65535, the form prefills the engine's port
  username: string;
  password?: string | null;
  database?: string | null; // default database; Postgres uses "postgres" when null
  tls: { mode: TlsMode; ca: string | null }; // ca = PEM text, only with "verify"
}
```

### Engine adapters (M2 slice of PLAN.md §5.1)

`engines/types.ts` defines the part M2 needs; later milestones extend it.

```ts
interface ExplorerAdapter {
  info(): Promise<ServerInfo>;
  variables(): Promise<ServerVariable[]>;           // name, value, description | null
  databases(): Promise<DatabaseEntry[]>;            // name, system: boolean
  schemas(db: string): Promise<SchemaEntry[]>;      // Postgres only; MySQL has none
  objects(db: string, schema: string | null): Promise<ObjectGroups>; // tables, views, procedures, functions
  close(): Promise<void>;
}
```

- **MySQL/MariaDB**: one adapter with a flavor flag. `information_schema` queries with `?`
  parameters. System databases: `information_schema`, `mysql`, `performance_schema`, `sys`.
  Variables: `SHOW GLOBAL VARIABLES`.
- **Visible databases**: the tree lists every database the user is allowed to open, not only the
  default one. MySQL's `SHOW DATABASES` already filters by grants; Postgres lists databases with
  `datallowconn` and `has_database_privilege(datname, 'CONNECT')`. If the listing query itself is
  denied, the tree shows just the default database. (Call.)
- **Postgres**: a connection is bound to one database, so the adapter keeps one pool per database
  it is asked about (created lazily, same idle close). System databases: `template0`, `template1`,
  and `postgres` unless `postgres` is the connection's configured default database (as on
  Supabase or RDS, where it holds user data). Dpilot servers have no configured default, so their
  `postgres` is grouped as system. (Call.) System schemas (`pg_catalog`, `information_schema`, `pg_toast`,
  `pg_temp_*`, `pg_toast_temp_*`) are hidden. Variables: `pg_settings` (with unit and
  `short_desc`). Databases with `datallowconn = false` are listed but not expandable.
- A `ConnectionManager` maps target id → adapter, creates on first use, closes on idle, and drops
  the adapter when a saved connection is edited or deleted or a Dpilot server is stopped/removed.

### Errors

Driver failures become `TargetError` with a code and a plain message, mapped in `app.ts`:

| code | HTTP | example message |
|------|------|-----------------|
| `target_not_found` | 404 | No connection or server with that id. |
| `target_unavailable` | 409 | The server orders is stopped. Start it to browse it. |
| `auth_failed` | 502 | The server rejected user root. Check the user and password. |
| `unreachable` | 502 | Nothing answered at db.example.com:5432. Check the host and port. |
| `tls_failed` | 502 | The TLS handshake failed: <driver reason>. |
| `timeout` | 504 | The server didn't answer within 10 seconds. |
| `query_failed` | 502 | driver message (catalog query failed) |

For a Dpilot server, `auth_failed` adds: "Dpilot uses the password the server was created with.
If you changed it inside the server, change it back or add the server as a saved connection." No
password override is stored for Dpilot servers in M2. (Call.)

Classification uses driver error codes (Postgres SQLSTATE `28P01`/`28000`, MySQL `1045`,
`ECONNREFUSED`, `ENOTFOUND`, TLS errors); the raw message is kept for `query_failed` only.

### API

```
GET    /api/targets
GET    /api/connections            saved connections (no passwords)
POST   /api/connections            create → 201
PATCH  /api/connections/:id        update (password omitted = keep)
DELETE /api/connections/:id        → 204
POST   /api/connections/test       body: ConnectionInput, or { id } to test a saved one,
                                   or { id, ...changes } to test edits before saving
GET    /api/c/:target/info
GET    /api/c/:target/variables
GET    /api/c/:target/databases
GET    /api/c/:target/db/:db/schemas            (Postgres)
GET    /api/c/:target/db/:db/objects?schema=    tables, views, procedures, functions
```

Test returns `{ ok: true, info }` or `{ ok: false, code, message }` with 200 — a failed test is an
answer, not an API error.

### Web

- **App shell**: header stays; below it a two-pane layout — sidebar (tree) on the left, the
  current screen on the right. Under 768 px the sidebar becomes a "Browse" disclosure above the
  content. Existing screens (home, new server, server detail) render in the right pane unchanged.
- **Sidebar tree**: one section per target, Dpilot servers first, then "Connections" with an
  "Add connection" action. Each level loads on expand (TanStack Query, keyed by target/db/schema)
  and shows its own loading and error line with a retry. Databases list the user's databases,
  then a collapsed "System databases" group. Unavailable targets show why and are not
  expandable. Keyboard support per the WAI-ARIA tree pattern (`role="tree"`, arrow keys, Enter,
  `aria-expanded`).
- **Connection form** (`/connections/new`, `/connections/:id/edit`): engine, host, port, user,
  password, default database, TLS (Off / Require / Verify with a CA certificate textarea), with
  "Test connection" and "Save connection". Delete with confirmation on the edit screen.
- **Server overview** (`/c/:target`): facts (engine, version, user, uptime, charset, time zone),
  and a variables table with a search box filtering name and value client-side. A Dpilot server's
  existing detail screen links to it ("Browse").
- **Database overview** (`/c/:target/db/:db`): lists of tables, views, procedures, functions
  (Postgres grouped by schema). Placeholder for M3's table view.
- Visual language: reuse M1 tokens, `Facts`, buttons and copy conventions.

### Testing

- Unit (TDD): id parsing, store + migrations (temp dir), secret box (round trip, tamper detection,
  missing key), connection service (create/update/keep-password/delete/drop-adapter), targets
  merge, error classification, route validation and status codes with fake adapters.
- Adapter integration tests against real MySQL, MariaDB and Postgres containers started by the
  test harness; skipped unless Docker is reachable and `DPILOT_INTEGRATION=1`. CI (Ubuntu) runs
  them.
- UI verified with real-browser screenshots (M1 convention; no DOM test environment).

## Calls made without the user (check these)

- External reach = plain + TLS; SSH tunnels deferred.
- Dpilot servers are live targets, not stored rows (deviates from PLAN.md's "auto-create one").
- SQLite connections move to M3; query history and saved-queries tables are not created yet.
- `postgres` is grouped with system databases unless it is the connection's default database.
- Saved connections keep working when Docker is down (partial `/api/targets`).
- Lost or wrong key: never overwrite the key file; affected passwords are re-entered.
- Changing engine, host or port requires re-entering the password.
- The tree lists every database the user may open, falling back to the default database.
- Dpilot servers whose password was changed inside the server get a clear `auth_failed`; no
  override.
- Variables are read-only in M2.
- Read-only connection mode deferred to M3.

## Left to the builder

Exact SQL for each catalog query, pool sizes and timeouts within the stated bounds, component
breakdown inside the web features, uptime formatting.
