# M2 Connections & Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saved connections (with encrypted passwords and TLS) plus Dpilot's own servers, browsable in a sidebar tree down to tables, with server info and variables.

**Architecture:** A `bun:sqlite` store holds external connections; passwords are AES-GCM sealed with a key file. An `Explorer` merges live Dpilot servers (from the instance service) and saved connections into targets, and hands out cached per-target engine adapters built on a small `SqlClient` interface over `Bun.SQL`. Hono routes expose `/api/connections`, `/api/targets` and `/api/c/:target/...`; the React app gains a two-pane shell with a lazy tree, a connection form and overview screens.

**Tech Stack:** Bun 1.4.4 (`bun:sqlite`, `Bun.SQL`, WebCrypto), Hono 4, Zod 4, React 19, TanStack Query 5, wouter 3.

**Spec:** `docs/superpowers/specs/2026-11-15-m2-connections-design.md`

## Global Constraints

- Strict types; Zod at every boundary (request bodies, stored rows read back, driver rows). No `any`.
- Anything `apps/server/src/app.ts` imports (transitively) must not import `node:*`, `bun:*` or use Bun globals: interfaces and error classes live in `types.ts` files; Bun-backed implementations are wired in `cli/run.ts`.
- Identifiers are never interpolated into SQL; catalog queries use parameters only.
- Passwords are never logged and never returned by `/api/connections`.
- Data dir `~/.dpilot`; store `~/.dpilot/dpilot.db`; key `~/.dpilot/key` (32 bytes, mode `0o600`, never overwritten).
- Biome: `lineWidth: 100`, 2-space indent. Biome is blocked locally (Application Control); keep lines ≤ 100 by hand; CI runs lint.
- Run tools through `bunx` (`.bin` shims are blocked locally). Typecheck: `bun run typecheck`. Tests: `bun test`.
- Commits: `git -c user.name="Manish Gupta" -c user.email=manishguptacpn@gmail.com commit ...`, Conventional Commits, **no Co-authored-by or other trailers**. Never push without asking.
- UI copy: sentence case, plain verbs, one name per action through the flow; reuse M1 tokens, `Facts`, `buttonClass`, `CopyButton`.
- Web components are verified by real-browser screenshots (no DOM test env); pure logic beside them is unit-tested.

## Review Focus

1. A saved connection whose host or port is edited with the password left blank must not send the old password anywhere — Task 4 test `rejects keeping the password when the host changes`; Task 7 route test for `/connections/test` with `{ id, host }`.
2. Docker stopped while saved connections exist: the sidebar must still list and open them — Task 6 test `lists saved connections when Docker is unavailable`.
3. A Dpilot server recreated under the same name (new port/password) must not reuse the old pool — Task 6 test `replaces the cached adapter when credentials change`.
4. Key file deleted after passwords were saved: the list still loads, affected rows are flagged, nothing is overwritten — Task 3 `never overwrites an existing key file`; Task 4 `flags passwords as lost when the key is missing`.
5. Database or schema names with quotes, dots, spaces or unicode (external servers allow them) must round-trip through URLs, tree ids and parameters — Task 5 `passes the database only as a parameter`; Task 7 `passes encoded database names through unchanged`; Task 9 `nodeId keeps names with dots and quotes distinct`.

---

### Task 1: Shared contracts

**Files:**
- Create: `packages/shared/src/connections.ts`, `packages/shared/src/connections.test.ts`
- Modify: `packages/shared/src/index.ts` (export everything below)

**Interfaces:**
- Produces (all exported from `@dpilot/shared`):
  - `tlsModeSchema = z.enum(["off", "require", "verify"])`, `type TlsMode`
  - `tlsSettingsSchema` → `{ mode: TlsMode; ca: string | null }`; `ca` non-null only with `"verify"`, must contain `-----BEGIN CERTIFICATE-----`, max 65 536 chars. `type TlsSettings`
  - `connectionInputSchema` (strict): `label` (trimmed, 1–64), `engine: engineIdSchema`, `host` (1–253, `/^[A-Za-z0-9.-]+$|^[0-9A-Fa-f:]+$/`), `port` (int 1–65535), `username` (1–128), `password?: string | null` (max 1024), `database?: string | null` (1–128), `tls: tlsSettingsSchema`. `type ConnectionInput`
  - `connectionPatchSchema = connectionInputSchema.partial().strict()`, `type ConnectionPatch`
  - `connectionTestRequestSchema = z.union([connectionInputSchema, connectionPatchSchema.extend({ id: z.uuid() })])`, `type ConnectionTestRequest`
  - `interface SavedConnection { id: string; label: string; engine: EngineId; host: string; port: number; username: string; database: string | null; tls: TlsSettings; hasPassword: boolean; passwordLost: boolean; createdAt: string; updatedAt: string }`
  - `targetIdSchema` (`^s\.[a-z][a-z0-9-]{0,29}[a-z0-9]$` or `^c\.[0-9a-f-]{36}$`), `type TargetId = string`, `parseTargetId(id: string): { kind: "server"; name: string } | { kind: "connection"; id: string } | null`
  - `type TargetSummary = { id: TargetId; kind: "server" | "connection"; label: string; engine: EngineId } & ({ available: true } | { available: false; reason: string })`
  - `interface TargetsResponse { servers: { status: "ok"; targets: TargetSummary[] } | { status: "unavailable"; message: string }; connections: TargetSummary[] }`
  - `interface ServerInfo { engine: EngineId; version: string; user: string; uptimeSeconds: number | null; charset: string | null; timeZone: string | null }`
  - `interface ServerVariable { name: string; value: string; description: string | null }`
  - `interface DatabaseEntry { name: string; system: boolean; browsable: boolean }`
  - `interface SchemaEntry { name: string }`
  - `interface ObjectGroups { tables: string[]; views: string[]; procedures: string[]; functions: string[] }`
  - `type TargetErrorCode = "target_not_found" | "target_unavailable" | "password_lost" | "auth_failed" | "unreachable" | "tls_failed" | "timeout" | "query_failed"`
  - `type TestResult = { ok: true; info: ServerInfo } | { ok: false; code: TargetErrorCode; message: string }`

- [ ] **Step 1: Write the failing tests** in `connections.test.ts`:

```ts
const valid = { label: "Prod", engine: "postgres", host: "db.example.com", port: 5432,
  username: "app", tls: { mode: "require", ca: null } };
test("accepts a minimal connection", () =>
  expect(connectionInputSchema.safeParse(valid).success).toBe(true));
test.each(["http://x", "db host", ""])("rejects host %p", (host) =>
  expect(connectionInputSchema.safeParse({ ...valid, host }).success).toBe(false));
test("rejects a CA without verify mode", () =>
  expect(connectionInputSchema.safeParse({ ...valid,
    tls: { mode: "require", ca: "-----BEGIN CERTIFICATE-----x" } }).success).toBe(false));
test("rejects unknown keys", () =>
  expect(connectionInputSchema.safeParse({ ...valid, id: "x" }).success).toBe(false));
test("test request accepts a saved id with changes", () =>
  expect(connectionTestRequestSchema.safeParse(
    { id: "0b7a3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", host: "h" }).success).toBe(true));
test.each([
  ["s.orders", { kind: "server", name: "orders" }],
  ["c.0b7a3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
    { kind: "connection", id: "0b7a3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d" }],
  ["x.orders", null], ["s.Orders", null], ["c.nope", null],
])("parseTargetId(%p)", (id, expected) => expect(parseTargetId(id)).toEqual(expected));
```

- [ ] **Step 2: Run** `bun test packages/shared/src/connections.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `connections.ts` with the exports above; re-export from `index.ts`.
- [ ] **Step 4: Run** the test and `bunx tsc --noEmit` in `packages/shared` — Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat(shared): connection and explorer contracts`.

---

### Task 2: Local store with migrations

**Files:**
- Create: `apps/server/src/store/database.ts`, `apps/server/src/store/database.test.ts`

**Interfaces:**
- Produces: `openStore(path: string): Database` (`bun:sqlite`; `":memory:"` allowed; creates the parent dir) — `PRAGMA journal_mode = WAL` (files only), `foreign_keys = ON`, then `migrate(db)`. `MIGRATIONS: readonly string[]`; `migrate(db: Database): void` applies `MIGRATIONS.slice(user_version)` in one transaction and sets `PRAGMA user_version = MIGRATIONS.length`.
- Migration 1:
  - `meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)`
  - `connections (id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE, engine TEXT NOT NULL CHECK (engine IN ('mysql','mariadb','postgres')), host TEXT NOT NULL, port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535), username TEXT NOT NULL, password_cipher BLOB, password_iv BLOB, password_lost INTEGER NOT NULL DEFAULT 0 CHECK (password_lost IN (0, 1)), database TEXT, tls_mode TEXT NOT NULL CHECK (tls_mode IN ('off','require','verify')), tls_ca TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, CHECK ((password_cipher IS NULL) = (password_iv IS NULL)))`

- [ ] **Step 1: Write failing tests**: `"migrates a new store to the latest version"` (`user_version` equals `MIGRATIONS.length`; both tables in `sqlite_master`); `"migrating twice is a no-op"`; `"keeps data across reopen"` (temp dir via `mkdtempSync`, insert, reopen, row present); `"rejects an unknown engine"` (insert engine `'oracle'` throws).
- [ ] **Step 2: Run** `bun test apps/server/src/store/database.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `database.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): local store with migrations`.

---

### Task 3: Secret box and key file

**Files:**
- Create: `apps/server/src/store/types.ts`, `apps/server/src/store/secret-box.ts`, `apps/server/src/store/secret-box.test.ts`, `apps/server/src/store/key-file.ts`, `apps/server/src/store/key-file.test.ts`

**Interfaces:**
- Produces in `store/types.ts` (no Bun/node imports): `interface Sealed { cipher: Uint8Array; iv: Uint8Array }`; `interface SecretBox { seal(plain: string): Promise<Sealed>; open(sealed: Sealed): Promise<string> }`; `class SecretBoxError extends Error`; `interface KeyStore { read(): Uint8Array | null; create(): Uint8Array }`.
- `createSecretBox(key: Uint8Array): Promise<SecretBox>` — AES-256-GCM via `crypto.subtle`, fresh 12-byte IV per `seal`; `open` throws `SecretBoxError` on any decrypt failure; throws `RangeError` unless the key is 32 bytes.
- `fileKeyStore(path: string): KeyStore` — `read` returns null when absent, throws when present but not 32 bytes; `create` makes the parent dir and writes 32 random bytes with flag `"wx"` and mode `0o600` (throws if the file exists).

- [ ] **Step 1: Write failing tests**: `"round-trips a password"`, `"uses a fresh IV each time"`, `"rejects a tampered cipher"` (flip a byte → `SecretBoxError`), `"rejects a different key"`, `"rejects a short key"`; key file: `"returns null when there is no key"`, `"creates a 32-byte key"`, `"never overwrites an existing key file"` (second `create()` throws, bytes unchanged), `"rejects a corrupt key file"` (10-byte file → throws).
- [ ] **Step 2: Run** `bun test apps/server/src/store` — Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): encrypt saved passwords with a local key`.

---

### Task 4: Connection service

**Files:**
- Create: `apps/server/src/connections/types.ts`, `apps/server/src/connections/service.ts`, `apps/server/src/connections/service.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas/types; `openStore` (Task 2); `createSecretBox`, `KeyStore` (Task 3).
- Produces in `connections/types.ts` (no Bun/node imports):
  - `interface ConnectionConfig { engine: EngineId; host: string; port: number; username: string; password: string | null; database: string | null; tls: TlsSettings }`
  - `type ConnectionErrorCode = "not_found" | "label_taken" | "password_required" | "password_lost" | "key_mismatch"`; `class ConnectionError extends Error { constructor(readonly code: ConnectionErrorCode, message: string) }`
  - `interface ConnectionService { list(): Promise<SavedConnection[]>; get(id: string): Promise<SavedConnection>; create(input: ConnectionInput): Promise<SavedConnection>; update(id: string, patch: ConnectionPatch): Promise<SavedConnection>; remove(id: string): Promise<void>; resolve(id: string): Promise<ConnectionConfig>; draft(request: ConnectionTestRequest): Promise<ConnectionConfig> }`
- `createConnectionService(deps: { db: Database; keys: KeyStore; now: () => Date; randomId: () => string; onChanged: (id: string) => void }): ConnectionService` in `service.ts`.

Behaviour (spec "Secrets"):
- Key check: `meta` row `key_check` = IV (12 bytes) ‖ cipher of `"dpilot-key-check"`. The key is *usable* when `keys.read()` returns bytes and either no check exists or the bytes open it.
- `passwordLost` = `password_lost = 1`, or a cipher is stored and the key isn't usable. `hasPassword` = a cipher is stored.
- `resolve` on a lost password → `password_lost` "Dpilot can't read this connection's saved password. Edit the connection and enter it again."
- Saving a password: key usable → seal. No key file → `keys.create()`, write a new check, and for every row with a cipher set `password_cipher = NULL, password_iv = NULL, password_lost = 1`; then seal. Key file present but failing the check → do not touch the file; throw `key_mismatch` "Dpilot's key file doesn't match its saved passwords. Restore ~/.dpilot/key, or delete it to start over and re-enter passwords." Saving a password (or `null`) clears `password_lost`.
- `update`/`draft`: omitted `password` keeps the stored one, `null` clears it. If `engine`, `host` or `port` differs from the stored row and `password` is omitted → `password_required` "Enter the password again: Dpilot doesn't send a saved password to a different server."
- UNIQUE label → `label_taken` "A connection named <label> already exists." Unknown id → `not_found`.
- `update` and `remove` call `onChanged(id)` after the write.
- Rows read back go through a Zod row schema; an invalid row is skipped in `list` with `console.warn` naming its id only.

- [ ] **Step 1: Write failing tests** (in-memory store; in-memory `KeyStore` fake recording `create` calls):

```ts
test("creates and lists without exposing the password", async () => {
  const saved = await svc.create({ ...input, password: "s3cret" });
  expect(saved).toMatchObject({ hasPassword: true, passwordLost: false });
  expect(JSON.stringify(await svc.list())).not.toContain("s3cret");
  expect((await svc.resolve(saved.id)).password).toBe("s3cret");
});
test("rejects keeping the password when the host changes", async () => {
  await expect(svc.update(id, { host: "other.example.com" }))
    .rejects.toMatchObject({ code: "password_required" });
  await expect(svc.draft({ id, port: 6543 })).rejects.toMatchObject({ code: "password_required" });
});
```

Plus: `"stores the password encrypted"` (raw `password_cipher` bytes don't contain the UTF-8 of `s3cret`), `"keeps the password when a patch omits it"`, `"clears the password when a patch sends null"`, `"allows a host change with a new password"`, `"rejects a duplicate label"` (`label_taken`), `"flags passwords as lost when the key is missing"` (new service over the same db with an empty `KeyStore` → `list()` `passwordLost: true`; `resolve` rejects `password_lost`), `"does not touch a key that fails the check"` (different 32-byte key → saving a password rejects `key_mismatch`; `create` not called), `"creates a new key when none exists and marks old passwords lost"`, `"re-entering a lost password clears the flag"`, `"notifies on update and remove"`, `"draft without id returns the input as config"`.

- [ ] **Step 2: Run** `bun test apps/server/src/connections` — Expected: FAIL.
- [ ] **Step 3: Implement** `types.ts` and `service.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): saved connection service`.

---

### Task 5: Engine adapters and error classification

**Files:**
- Create: `apps/server/src/engines/types.ts`, `apps/server/src/engines/errors.ts`, `apps/server/src/engines/errors.test.ts`, `apps/server/src/engines/mysql.ts`, `apps/server/src/engines/mysql.test.ts`, `apps/server/src/engines/postgres.ts`, `apps/server/src/engines/postgres.test.ts`, `apps/server/src/engines/registry.ts`, `apps/server/src/engines/bun-sql.ts`, `apps/server/src/testing/fake-sql.ts`

**Interfaces:**
- Consumes: `ConnectionConfig` (Task 4); shared types (Task 1).
- Produces in `engines/types.ts` (no Bun/node imports):
  - `interface SqlClient { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<T[]>; close(): Promise<void> }`
  - `type SqlClientFactory = (config: ConnectionConfig, database: string | null) => SqlClient`
  - `interface ExplorerAdapter { info(): Promise<ServerInfo>; variables(): Promise<ServerVariable[]>; databases(): Promise<DatabaseEntry[]>; schemas(db: string): Promise<SchemaEntry[]>; objects(db: string, schema: string | null): Promise<ObjectGroups>; close(): Promise<void> }`
  - `interface AdapterContext { managed: boolean }` (true for Dpilot servers)
  - `class TargetError extends Error { constructor(readonly code: TargetErrorCode, message: string) }`
- `errors.ts`: `classifyError(error: unknown, config: ConnectionConfig, ctx: AdapterContext): TargetError` reading Bun.SQL fields `code: string`, `errno?: string | number`, `sqlState?: string`, and node-style `code`:
  - Postgres errno `28P01`/`28000`, MySQL errno `1045` → `auth_failed` "The server rejected user <username>. Check the user and password." When `ctx.managed`, append the spec's Dpilot-server sentence.
  - `ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`, or a code containing `CONNECTION_REFUSED` → `unreachable` "Nothing answered at <host>:<port>. Check the host and port."
  - code containing `TIMEOUT` or `ETIMEDOUT` → `timeout` "The server didn't answer within 10 seconds."
  - code or message containing `TLS`, `SSL` or `CERT` → `tls_failed` "The TLS handshake failed: <message>"
  - otherwise → `query_failed` with the driver message.
  - `isPermissionDenied(error: unknown): boolean` — Postgres `42501`, MySQL `1044`/`1227`.
- `createMysqlAdapter(config, factory, ctx)`, `createPostgresAdapter(config, factory, ctx)`, and `createAdapter(config, factory, ctx): ExplorerAdapter` in `registry.ts` (mysql/mariadb → MySQL adapter).
- `bun-sql.ts`: `bunSqlFactory: SqlClientFactory` → `new SQL({ adapter, hostname, port, username, password, database, tls, max: 2, idleTimeout: 60, connectionTimeout: 10 })`; `tls`: `off` → `"disable"`, `require` → `"require"`, `verify` → `ca ? { ca } : "verify-full"`; `query` = `sql.unsafe(text, params)`; `close` = `sql.close()`. Covered by Task 8, not unit-tested.
- `testing/fake-sql.ts`: `class FakeSqlFactory { factory: SqlClientFactory; respond(pattern: RegExp, result: unknown[] | Error): void; calls: { database: string | null; text: string; params: readonly unknown[] }[]; created: (string | null)[]; closed: (string | null)[] }`.

Adapter rules (spec "Engine adapters"; parse driver rows with Zod; wrap every catalog call so failures go through `classifyError`):
- MySQL: one client on `config.database`. `info` from `SELECT VERSION() AS version, CURRENT_USER() AS user, @@character_set_server AS charset, @@time_zone AS timeZone` and `SHOW GLOBAL STATUS LIKE 'Uptime'`. `variables` from `SHOW GLOBAL VARIABLES` (description null). `databases` from `SHOW DATABASES`; system = `information_schema`, `mysql`, `performance_schema`, `sys`; browsable true. `schemas` → `[]`. `objects(db)` from `information_schema.TABLES` (`BASE TABLE` → tables; `VIEW`/`SYSTEM VIEW` → views) and `information_schema.ROUTINES` (`PROCEDURE`/`FUNCTION`), `db` as `?`, columns aliased `AS name`, `AS type`, sorted by name.
- Postgres: one client per database, created lazily (`config.database ?? "postgres"` for server-level queries); `close` closes all. `info` from `current_setting('server_version')`, `current_user`, `EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint` (coerced to number), `current_setting('server_encoding')`, `current_setting('TimeZone')`. `variables` from `pg_settings` (value = `setting` + `" " + unit` when a unit exists; description = `short_desc`). `databases`: every `pg_database` row; `browsable = datallowconn AND has_database_privilege(datname, 'CONNECT')`; system = `template0`, `template1`, and `postgres` unless `config.database === "postgres"`. `schemas(db)` from `pg_namespace` excluding `pg_catalog`, `information_schema`, `pg_toast`, `pg_temp_%`, `pg_toast_temp_%`. `objects(db, schema ?? "public")`: `pg_class` relkind `r`/`p` → tables, `v`/`m` → views; `pg_proc` prokind `f` → functions, `p` → procedures; schema as `$1`.
- Both: when the database listing fails with `isPermissionDenied` and `config.database` is set, return `[{ name: config.database, system: false, browsable: true }]`; otherwise rethrow the classified error.

- [ ] **Step 1: Write failing tests**:
  - `errors.test.ts` table: `{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "28P01" }` → `auth_failed`; `{ code: "ERR_MYSQL_SERVER_ERROR", errno: 1045 }` → `auth_failed`; `{ code: "ECONNREFUSED" }` → `unreachable`; `{ code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }` → `timeout`; `{ code: "ERR_POSTGRES_TLS_NOT_AVAILABLE" }` → `tls_failed`; `new Error("boom")` → `query_failed` "boom". Plus `"adds the Dpilot server hint to auth failures"` (message contains "the password the server was created with").
  - `mysql.test.ts`: `"marks system databases"` (`app`, `mysql`, `sys` → only `app` non-system), `"groups tables, views and routines"`, `"passes the database only as a parameter"` (db `` we`ird"db `` → last call's `params` equal `[that name]`; `text` doesn't contain it), `"falls back to the default database when listing is denied"`, `"classifies driver errors"` (`{ errno: 1045 }` → rejects with code `auth_failed`).
  - `postgres.test.ts`: `"treats postgres as system only when it isn't the default"`, `"marks databases that refuse connections as not browsable"`, `"excludes system schemas in the query"` (text contains `pg_toast` and `pg_temp`), `"opens one client per database and closes them all"`, `"formats variables with units"` (`"128"` + `"MB"` → `"128 MB"`), `"coerces uptime to a number"` (`"3600"` → `3600`).
- [ ] **Step 2: Run** `bun test apps/server/src/engines` — Expected: FAIL.
- [ ] **Step 3: Implement** the modules.
- [ ] **Step 4: Run** the tests and `bunx tsc --noEmit` in `apps/server` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): MySQL, MariaDB and Postgres explorer adapters`.

---

### Task 6: Explorer (targets, adapter cache, test)

**Files:**
- Create: `apps/server/src/explorer/types.ts`, `apps/server/src/explorer/service.ts`, `apps/server/src/explorer/service.test.ts`

**Interfaces:**
- Consumes: `InstanceService.list()`/`get(name)` (`InstanceDetail.connection: InstanceConnection | null`, `state`), `InstanceError` (`not_found`), `DockerUnavailableError`, `DockerTimeoutError`; `ConnectionService`, `ConnectionError` (Task 4); `createAdapter`, `SqlClientFactory`, `TargetError` (Task 5).
- Produces in `explorer/types.ts` (no Bun/node imports): `interface Explorer { targets(): Promise<TargetsResponse>; run<T>(target: TargetId, use: (adapter: ExplorerAdapter) => Promise<T>): Promise<T>; test(request: ConnectionTestRequest): Promise<TestResult>; forget(target: TargetId): Promise<void> }`
- `createExplorer(deps: { instances: InstanceService; connections: ConnectionService; sql: SqlClientFactory }): Explorer`

Behaviour:
- `targets()`: servers from `instances.list()` as `s.<name>`, label = name, ready → available; reasons: `stopped`/`dead`/`paused` → "Stopped. Start it to browse it."; `pulling`/`creating`/`starting`/`restarting` → "Still starting."; `failed`/`unhealthy` → "Not healthy. Check its logs.". `DockerUnavailableError`/`DockerTimeoutError` → `servers: { status: "unavailable", message: "Docker isn't reachable, so Dpilot's servers can't be listed." }`. Connections as `c.<id>`; `passwordLost` → unavailable "Enter the password again to browse it.".
- `run(target, use)`: `parseTargetId` null → `target_not_found` "No connection or server with that id.". Server: `instances.get` (`not_found` → `target_not_found`); not ready → `target_unavailable` "The server <name> is stopped. Start it to browse it." (or "The server <name> is still starting."); config from `connection` (`tls: { mode: "off", ca: null }`), ctx `managed: true`. Connection: `connections.resolve` (`not_found` → `target_not_found`; `password_lost` → `TargetError("password_lost", same message)`), ctx `managed: false`. Cache `Map<TargetId, { fingerprint: string; adapter }>`, fingerprint `JSON.stringify(config)`; on mismatch close the old adapter first. If `use` rejects with a `TargetError` coded `auth_failed`, `unreachable`, `tls_failed` or `timeout`, close and evict before rethrowing.
- `test(request)`: `connections.draft(request)` (`ConnectionError` propagates), fresh uncached adapter, `info()`, always `close()`; `TargetError` → `{ ok: false, code, message }`.
- `forget(target)`: close and evict.

- [ ] **Step 1: Write failing tests** using `createInstanceService` + `FakeEngineApi` (as `testing/build-app.ts` does), a real `createConnectionService` over `openStore(":memory:")`, and `FakeSqlFactory`: `"lists Dpilot servers first, then saved connections"`, `"explains why a stopped server can't be browsed"`, `"lists saved connections when Docker is unavailable"`, `"reuses one adapter per target"` (factory called once across two `run`s), `"replaces the cached adapter when credentials change"` (recreate the fake container with a new password → old client closed, new one created), `"evicts the adapter after a connection failure"`, `"returns not found for an unknown target"`, `"test reports a failure as a result"` (`{ ok: false, code: "auth_failed" }`), `"test closes its adapter"`.
- [ ] **Step 2: Run** `bun test apps/server/src/explorer` — Expected: FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `feat(server): explorer targets and adapter cache`.

---

### Task 7: Routes, error mapping and wiring

**Files:**
- Create: `apps/server/src/routes/connections.ts`, `apps/server/src/routes/connections.test.ts`, `apps/server/src/routes/explorer.ts`, `apps/server/src/routes/explorer.test.ts`
- Modify: `apps/server/src/app.ts`, `apps/server/src/cli/run.ts`, `apps/server/src/testing/build-app.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6.
- `AppDeps` gains `connections: ConnectionService` and `explorer: Explorer`.
- Routes (under the session guard):
  - `/connections`: `GET /` → `SavedConnection[]`; `POST /` (`connectionInputSchema`) → 201; `GET /:id`; `PATCH /:id` (`connectionPatchSchema`); `DELETE /:id` → 204; `POST /test` (`connectionTestRequestSchema`) → 200 `TestResult`. Register `/test` before `/:id`.
  - `/targets`: `GET /` → `TargetsResponse`.
  - `/c/:target`: `GET /info`, `GET /variables`, `GET /databases`, `GET /db/:db/schemas`, `GET /db/:db/objects?schema=`. `:target` must pass `targetIdSchema` (else 404 `target_not_found`); `:db` 1–128 chars; `schema` optional, 1–128.
  - Validation failures: 400 `{ error: "invalid_request", issues }`, same shape as the instance routes.
- `errorResponse`: `ConnectionError` → `not_found` 404, `label_taken` 409, `password_required` 400, `password_lost` 409, `key_mismatch` 409; `TargetError` → `target_not_found` 404, `target_unavailable` 409, `password_lost` 409, `auth_failed`/`unreachable`/`tls_failed`/`query_failed` 502, `timeout` 504. Body `{ error: code, message }`.
- `build-app.ts`: in-memory store, in-memory `KeyStore`, `FakeSqlFactory` (returned as `sql`), real connection service and explorer; `onChanged` wired to `explorer.forget`.
- `run.ts`: `dataDir = join(homedir(), ".dpilot")`; `openStore(join(dataDir, "dpilot.db"))`; `fileKeyStore(join(dataDir, "key"))`; `createConnectionService({ db, keys, now: () => new Date(), randomId: () => crypto.randomUUID(), onChanged: (id) => void explorer.forget(\`c.${id}\`) })` with `explorer` created right after (the callback runs later, so the closure reference is safe); `createExplorer({ instances, connections, sql: bunSqlFactory })`.

- [ ] **Step 1: Write failing tests** with `buildTestApp`: `"creates, reads, updates and deletes a connection"` (201/200/200/204, then 404), `"never returns the password"`, `"rejects an invalid body"` (400 `invalid_request`), `"rejects a duplicate label"` (409 `label_taken`), `"asks for the password when the host changes"` (PATCH `{ host }` → 400 `password_required`; POST `/connections/test` `{ id, host }` → 400), `"reports a failed test as ok false"` (fake throws `{ errno: 1045 }` → 200 `{ ok: false, code: "auth_failed" }`), `"lists targets"`, `"returns 404 for an unknown target id"` (`/api/c/x.bad/info`), `"returns 409 for a stopped server"`, `"maps unreachable to 502"`, `"lists databases for a saved connection"`, `"passes encoded database names through unchanged"` (GET `/api/c/<id>/db/${encodeURIComponent('we"ird db')}/objects` → fake recorded `params` contain `'we"ird db'`).
- [ ] **Step 2: Run** `bun test apps/server/src/routes` — Expected: FAIL.
- [ ] **Step 3: Implement** routes, `app.ts`, `build-app.ts`, `run.ts`.
- [ ] **Step 4: Run** `bun test` and `bun run typecheck` — Expected: all pass, including the web typecheck (proves `app.ts` pulls in nothing Bun-only).
- [ ] **Step 5: Smoke test**: `bun src/main.ts --port 7399 --no-open` in `apps/server`; create a Postgres Dpilot server with first database `app`; through the session helper `GET /api/targets` and `/api/c/s.<name>/databases`. Expected: the server listed as available; `app` non-system, `postgres` system. Stop the server process, remove the container and volume.
- [ ] **Step 6: Commit** `feat(server): connections and explorer API`.

---

### Task 8: Integration tests against real servers

**Files:**
- Create: `apps/server/src/engines/integration.test.ts`
- Modify: `.github/workflows/ci.yml`, `README.md` (Develop table)

**Interfaces:**
- Consumes: the real Docker client, engine API and instance service (wired as in `run.ts`), `bunSqlFactory`, `createAdapter`.

- [ ] **Step 1: Write the tests** inside `describe.skipIf(process.env.DPILOT_INTEGRATION !== "1")`. `beforeAll` (timeout 600 000 ms) creates `it-mysql` (mysql 8.4), `it-mariadb` (mariadb 11.8) and `it-postgres` (postgres 17), each with database `app`, awaits `settled`, then creates one table, one view, one procedure and one function in `app` per engine through a `bunSqlFactory` client. `afterAll` removes all three with `removeVolume: true`. Per engine: `"<engine> separates app from the system databases"`, `"<engine> lists the table, view, procedure and function"` (Postgres in schema `public`), `"<engine> reports info"` (non-empty version, uptime > 0), `"<engine> reports variables"` (more than 100), `"<engine> classifies a wrong password as auth_failed"`. Plus `"classifies a closed port as unreachable"` (port of a just-stopped listener) and `"fails a require-TLS connection to a server without TLS as tls_failed"` (Postgres).
- [ ] **Step 2: Run** `$env:DPILOT_INTEGRATION="1"; bun test apps/server/src/engines/integration.test.ts --timeout 600000` — Expected: PASS. If a classification test fails, record the real error's `code`/`errno`/`message` in the ledger, add it to `errors.test.ts` (RED), fix `classifyError` (GREEN), rerun.
- [ ] **Step 3: Run** `bun test` without the variable — Expected: integration tests skipped, the rest pass.
- [ ] **Step 4: Add the CI step** after "Test": name `Integration tests`, `if: runner.os == 'Linux'`, `env: { DPILOT_INTEGRATION: "1" }`, `run: bun test apps/server/src/engines/integration.test.ts --timeout 600000`. README Develop table row: `DPILOT_INTEGRATION=1 bun test apps/server/src/engines/integration.test.ts` — "Run the engine adapters against real database containers (needs Docker)".
- [ ] **Step 5: Confirm cleanup**: `docker ps -a --filter label=dpilot.managed=true` lists no `dpilot-it-*`; `docker volume ls` lists no `dpilot_it-*`.
- [ ] **Step 6: Commit** `test(server): explorer adapters against real servers`.

---

### Task 9: Web — API hooks, app shell and sidebar tree

**Files:**
- Create: `apps/web/src/api/explorer.ts`, `apps/web/src/api/connections.ts`, `apps/web/src/features/explorer/tree-model.ts`, `apps/web/src/features/explorer/tree-model.test.ts`, `apps/web/src/features/explorer/Sidebar.tsx`, `apps/web/src/features/explorer/TreeNode.tsx`
- Modify: `apps/web/src/App.tsx`

**Interfaces:**
- Consumes: Task 7 routes via `api`, `unwrap`, `unwrapEmpty`, `ApiError`.
- Produces:
  - `api/explorer.ts`: `useTargets()`, `useServerInfo(target)`, `useVariables(target)`, `useDatabases(target, enabled)`, `useSchemas(target, db, enabled)`, `useObjects(target, db, schema: string | null, enabled)`. Keys `["targets"]` and `["c", target, ...rest]`. No retry on 4xx.
  - `api/connections.ts`: `useConnection(id)`, `useCreateConnection()`, `useUpdateConnection(id)`, `useDeleteConnection(id)`, `useTestConnection()`. Mutations invalidate `["targets"]`, `["connections"]`, and remove `["c", "c.<id>"]` on update/delete.
  - `tree-model.ts` (pure): `nodeId(parts: readonly string[]): string` (`JSON.stringify(parts)`); `interface VisibleNode { id: string; parent: string | null; expandable: boolean; expanded: boolean }`; `type TreeKey = "ArrowDown" | "ArrowUp" | "ArrowRight" | "ArrowLeft" | "Home" | "End"`; `nextFocus(nodes: readonly VisibleNode[], current: string, key: TreeKey): { focus: string; toggle: boolean }` per the WAI-ARIA tree pattern (Right on collapsed → toggle; Right on expanded → first child; Left on expanded → toggle; Left on collapsed → parent; Up/Down → previous/next visible; Home/End → first/last).
- Sidebar (spec "Sidebar tree"): section "Dpilot servers" (or the unavailable message), section "Connections" with an "Add connection" link to `/connections/new`. Levels: target → user databases, then a collapsed "System databases" group → (Postgres) schemas → "Tables", "Views", "Procedures", "Functions" (non-empty only) → names (plain text). Each level shows "Loading…" or the server's error message with a "Try again" button. Unavailable targets show their reason and aren't expandable; non-browsable databases aren't expandable. Target rows link to `/c/<target>`, database rows to `/c/<target>/db/<encodeURIComponent(db)>`. `role="tree"`/`treeitem`/`group`, `aria-expanded`, roving `tabIndex`.
- Shell: shown only for the app view (not session/status screens). ≥ 768 px: left column `w-72`, sticky, scrolling independently, content on the right; widen the container from `max-w-5xl` to fit. < 768 px: the sidebar sits in a `<details>` "Browse" disclosure above the content.

- [ ] **Step 1: Write failing tests** `tree-model.test.ts`: `"nodeId keeps names with dots and quotes distinct"` (`nodeId(["a.b", "c"]) !== nodeId(["a", "b.c"])`, and a name containing `"` round-trips through `JSON.parse`), `"ArrowDown moves to the next visible node"`, `"ArrowRight opens a collapsed node"`, `"ArrowRight on an open node moves to its first child"`, `"ArrowLeft on a closed node moves to its parent"`, `"Home and End jump to the ends"`.
- [ ] **Step 2: Run** `bun test apps/web/src/features/explorer` — Expected: FAIL.
- [ ] **Step 3: Implement** `tree-model.ts`, the hooks, `TreeNode.tsx`, `Sidebar.tsx`, and the shell.
- [ ] **Step 4: Run** `bun test apps/web` and `bun run typecheck` — Expected: PASS.
- [ ] **Step 5: Verify in a browser**: `bun run dev` with one running Dpilot Postgres server; headless-Edge screenshots at 1280 and 390 px wide (as in M1); expand server → database → schema → tables by keyboard. Expected: tree renders, system databases collapsed, visible focus ring.
- [ ] **Step 6: Commit** `feat(web): sidebar explorer tree`.

---

### Task 10: Web — connection form

**Files:**
- Create: `apps/web/src/features/connections/form-model.ts`, `apps/web/src/features/connections/form-model.test.ts`, `apps/web/src/features/connections/ConnectionForm.tsx`, `apps/web/src/features/connections/ConnectionScreens.tsx`
- Modify: `apps/web/src/App.tsx` (routes `/connections/new`, `/connections/:id/edit`)

**Interfaces:**
- Consumes: Task 9 connection hooks; `connectionInputSchema`, `connectionPatchSchema`, `ENGINES`.
- Produces `form-model.ts` (pure):
  - `interface FormValues { label: string; engine: EngineId; host: string; port: string; username: string; password: string; database: string; tlsMode: TlsMode; ca: string }`
  - `emptyForm(engine: EngineId): FormValues` — host `127.0.0.1`, engine's default port and user, `tlsMode: "off"`.
  - `fromSaved(saved: SavedConnection): FormValues` — password `""`.
  - `toInput(values: FormValues): ConnectionInput` — blank database/password → `null`; `ca` only with `verify`, else `null`.
  - `toPatch(values: FormValues, saved: SavedConnection): ConnectionPatch` — changed fields only; blank password omitted.
  - `needsPassword(values: FormValues, saved: SavedConnection): boolean` — engine, host or port changed and password blank.
  - `switchEngine(values: FormValues, engine: EngineId): FormValues` — replaces port/user only where they still equal the previous engine's defaults.
- `ConnectionScreens.tsx` exports `NewConnectionScreen` and `EditConnectionScreen({ id })`. Fields: Label, Engine (segmented, like the new-server screen), Host, Port, User, Password (edit with `hasPassword`: placeholder "Saved. Leave empty to keep it."; "Enter the password again" note when `needsPassword` or `passwordLost`), Default database (optional), TLS (Off / Require / Verify; CA certificate textarea only with Verify). Buttons "Test connection" (inline result, `aria-live="polite"`: "Connected to <Engine label> <version>." or the failure message) and "Save connection" (navigates to `/c/c.<id>`; disabled while `needsPassword`). Edit screen: "Delete connection" with a confirm step "Delete <label>? Dpilot forgets this connection. The server isn't changed." Server `issues` map to fields as in `NewInstanceScreen`.

- [ ] **Step 1: Write failing tests** `form-model.test.ts`: `"emptyForm uses the engine's port and user"`, `"switchEngine keeps a port the user typed"`, `"toInput turns blanks into null"`, `"toInput drops the CA unless verifying"`, `"toPatch omits a blank password"`, `"needsPassword when the host changes and the password is blank"`, `"no password needed for a label-only change"`.
- [ ] **Step 2: Run** `bun test apps/web/src/features/connections` — Expected: FAIL.
- [ ] **Step 3: Implement** `form-model.ts`, then the components and routes.
- [ ] **Step 4: Run** `bun test apps/web` and `bun run typecheck` — Expected: PASS.
- [ ] **Step 5: Verify in a browser**: add a connection to a running Dpilot MySQL server with its host, port and password; Test (success); Save; it appears under "Connections". Edit the host to `127.0.0.2` with a blank password → the note shows and Save is disabled. Delete it. Screenshots at 1280 and 390 px.
- [ ] **Step 6: Commit** `feat(web): add, test and edit saved connections`.

---

### Task 11: Web — server and database overviews, docs

**Files:**
- Create: `apps/web/src/features/explorer/overview-model.ts`, `apps/web/src/features/explorer/overview-model.test.ts`, `apps/web/src/features/explorer/ServerOverview.tsx`, `apps/web/src/features/explorer/DatabaseOverview.tsx`
- Modify: `apps/web/src/App.tsx` (routes `/c/:target`, `/c/:target/db/:db`), `apps/web/src/features/instances/InstanceScreen.tsx` ("Browse" link to `/c/s.<name>` when ready), `README.md`, `docs/PLAN.md`

**Interfaces:**
- Consumes: Task 9 hooks.
- Produces `overview-model.ts` (pure): `formatUptime(seconds: number | null): string` — `null` → "—", `45` → "45 seconds", `720` → "12 minutes", `11040` → "3 hours 4 minutes", `190800` → "2 days 5 hours", `1` → "1 second"; `filterVariables(vars: readonly ServerVariable[], query: string): ServerVariable[]` — case-insensitive on name or value; blank → all.
- `ServerOverview({ target })`: heading = target label; subline "<Engine label> <version>"; `Facts` for User, Uptime, Charset (MySQL) / Encoding (Postgres), Time zone; "Variables" with a search input labelled "Search variables", count "<n> of <total>", and a table (Name, Value, plus Description when any variable has one). Saved connections get an "Edit connection" link. Errors show the server message and "Try again".
- `DatabaseOverview({ target, db })`: heading = db name; MySQL: Tables / Views / Procedures / Functions; Postgres: per schema, the same groups. Empty groups read "No tables.", "No views.", etc. Names are plain text (opening tables is M3).
- README "What you can do": saved connections (TLS), sidebar tree, server and database overviews; where data lives (`~/.dpilot/dpilot.db`, `~/.dpilot/key`, user-only permissions; on Windows the user-profile ACL applies) and what losing the key means. PLAN.md §6: note that Dpilot servers are live targets rather than stored connection rows, linking the spec.

- [ ] **Step 1: Write failing tests** `overview-model.test.ts`: each `formatUptime` example above; `"matches name or value, ignoring case"`; `"blank query returns everything"`.
- [ ] **Step 2: Run** `bun test apps/web/src/features/explorer` — Expected: FAIL.
- [ ] **Step 3: Implement** the model, screens, routes, Browse link, README and PLAN.md edits.
- [ ] **Step 4: Run** `bun test`, `bun run typecheck`, and `bunx vite build` in `apps/web` — Expected: all pass.
- [ ] **Step 5: Verify M2 acceptance**: with a Dpilot Postgres server (first database `app`) and a saved connection to a Dpilot MySQL server, open both server overviews (variable search filters), expand both trees to tables, open a database overview for each. Screenshots at 1280 and 390 px. Remove the test servers and volumes, and delete the test connection.
- [ ] **Step 6: Commit** `feat(web): server and database overviews`.
