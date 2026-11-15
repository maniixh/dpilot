# Dpilot — Project Plan

> One local platform to create, run and manage databases using Docker and a web UI.

## 1. Goals & Non-goals

**Goals**

- Provision databases (MySQL, MariaDB, PostgreSQL, MongoDB, Redis) as Docker containers in a few clicks; SQLite as local files.
- Connect to external/remote servers too (host, port, user, password).
- Full admin UI: schema, data, indexes, relationships, routines, SQL editor, import/export, users, backups.
- Ship as a single executable: `dpilot` starts the server and opens the browser.

**Non-goals (v1)**

- Multi-user / hosted deployment (local, single user only).
- Production cluster management (replication, sharding, Kubernetes).
- Cloud-managed DB provisioning (RDS, Atlas, …) — connecting to them is fine.

## 2. Architecture

```
┌──────────────────────── dpilot (single binary) ────────────────────────┐
│                                                                        │
│  React SPA (embedded static assets)                                    │
│        │  REST (JSON)            │ WebSocket (progress, logs, stats)   │
│        ▼                         ▼                                     │
│  Hono HTTP server  ── auth middleware (session token, localhost only)  │
│        │                                                               │
│  ┌─────┴──────────────┬───────────────────┬─────────────────────┐      │
│  │ Docker service     │ Engine registry   │ Local store         │      │
│  │ (Engine API)       │ (adapters)        │ (bun:sqlite)        │      │
│  └─────┬──────────────┴─────┬─────────────┴──────────┬──────────┘      │
└────────┼────────────────────┼────────────────────────┼─────────────────┘
         ▼                    ▼                        ▼
  Docker daemon        DB servers (containers   ~/.dpilot/dpilot.db
  (socket / npipe)     or external hosts)       (connections, history…)
```

## 3. Tech Stack

| Layer                      | Choice                                              | Notes                                                  |
| -------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| Runtime / tooling          | Bun (workspaces, test runner, bundler, `--compile`) |                                                        |
| Backend                    | Hono                                                | Typed routes, works with `Bun.serve`, WebSocket helper |
| Validation                 | Zod (shared between server & web)                   |                                                        |
| Frontend                   | React + Vite + TypeScript                           |                                                        |
| UI                         | Tailwind CSS + shadcn/ui                            |                                                        |
| Routing / data             | TanStack Router + TanStack Query                    |                                                        |
| Data grid                  | TanStack Table + TanStack Virtual                   | Large result sets                                      |
| SQL editor                 | CodeMirror 6 (`@codemirror/lang-sql`)               | Schema-aware autocomplete                              |
| ER diagram                 | React Flow (`@xyflow/react`) + ELK/dagre layout     |                                                        |
| Postgres / MySQL / MariaDB | `Bun.sql`                                           | Fallback: `pg` / `mysql2` if gaps found in M0 spike    |
| SQLite                     | `bun:sqlite`                                        |                                                        |
| MongoDB                    | `mongodb` official driver                           |                                                        |
| Redis                      | Bun built-in Redis client                           | Fallback: `ioredis`                                    |
| Docker                     | Docker Engine HTTP API                              | Unix socket / Windows named pipe; no shell strings     |

## 4. Repository Structure (Bun workspaces)

```
dpilot/
├─ package.json                # workspaces, root scripts
├─ tsconfig.base.json
├─ biome.json                  # lint + format
├─ docs/PLAN.md
├─ apps/
│  ├─ server/
│  │  └─ src/
│  │     ├─ cli.ts             # entry: parse args, start server, open browser
│  │     ├─ app.ts             # Hono app composition
│  │     ├─ config.ts          # paths (~/.dpilot), port, env
│  │     ├─ auth/              # session token middleware, origin checks
│  │     ├─ docker/
│  │     │  ├─ client.ts       # Engine API client
│  │     │  ├─ transport.ts    # unix socket / npipe / DOCKER_HOST detection
│  │     │  ├─ containers.ts   # create/start/stop/remove/logs/stats
│  │     │  ├─ images.ts       # pull (streamed progress), list tags
│  │     │  └─ catalog.ts      # engine → image, ports, env, volumes, probes
│  │     ├─ engines/
│  │     │  ├─ types.ts        # adapter interface + capabilities
│  │     │  ├─ registry.ts
│  │     │  ├─ sql/            # shared SQL-family helpers (quoting, paging)
│  │     │  ├─ mysql/          # MySQL + MariaDB (dialect flags)
│  │     │  ├─ postgres/
│  │     │  ├─ sqlite/
│  │     │  ├─ mongodb/
│  │     │  └─ redis/
│  │     ├─ store/             # bun:sqlite: connections, history, saved queries, settings
│  │     ├─ services/          # export, import, backup/restore, compose export
│  │     ├─ routes/            # REST route modules
│  │     └─ ws/                # WebSocket channels
│  └─ web/
│     └─ src/
│        ├─ api/               # typed client (Hono RPC) + query hooks
│        ├─ routes/            # pages
│        ├─ features/          # containers, explorer, table, editor, erd, import-export, users
│        └─ components/        # shared UI
└─ packages/
   └─ shared/                  # zod schemas, DTO types, capability enums, engine ids
```

## 5. Core Concepts

### 5.1 Engine adapter interface

Every engine implements one interface; the UI reads `capabilities` and hides what is unsupported.

```ts
type EngineId = "mysql" | "mariadb" | "postgres" | "sqlite" | "mongodb" | "redis";

type Capability =
  | "databases"
  | "schemas"
  | "tables"
  | "columns"
  | "indexes"
  | "fulltext"
  | "foreignKeys"
  | "checks"
  | "generatedColumns"
  | "views"
  | "procedures"
  | "functions"
  | "triggers"
  | "storageEngines"
  | "collations"
  | "autoIncrement"
  | "comments"
  | "users"
  | "variables"
  | "processList"
  | "sqlEditor"
  | "documents"
  | "keyValue"
  | "explain"
  | "transactions";

interface EngineAdapter {
  id: EngineId;
  family: "sql" | "document" | "keyvalue";
  capabilities: Set<Capability>;
  connect(cfg: ConnectionConfig): Promise<Session>;
}

interface Session {
  ping(): Promise<ServerInfo>;
  close(): Promise<void>;
  // feature modules are optional, present only when capability exists
  databases?: DatabaseOps; // list/create/drop/settings
  schema?: SchemaOps; // tables, columns, indexes, FKs, checks, triggers
  data?: DataOps; // browse (paged), filter, sort, CRUD, aggregate
  routines?: RoutineOps; // views, procedures, functions
  query?: QueryOps; // execute, explain, cancel, stream
  admin?: AdminOps; // users/privileges, variables, process list
  io?: ImportExportOps; // dump/restore, CSV/JSON/SQL
}
```

- DDL is generated by per-dialect builders from structured input (e.g. `AlterTableSpec`) and shown to the user as a **SQL preview** before running.
- Identifiers are always quoted by the dialect; values are always parameterized.
- MariaDB reuses the MySQL adapter with dialect flags.

### 5.2 Engine catalog (Docker)

| Engine     | Image            | Port  | Credentials env                       | Data path                              |
| ---------- | ---------------- | ----- | ------------------------------------- | -------------------------------------- |
| MySQL      | `mysql:<tag>`    | 3306  | `MYSQL_ROOT_PASSWORD`                 | `/var/lib/mysql`                       |
| MariaDB    | `mariadb:<tag>`  | 3306  | `MARIADB_ROOT_PASSWORD`               | `/var/lib/mysql`                       |
| PostgreSQL | `postgres:<tag>` | 5432  | `POSTGRES_USER`, `POSTGRES_PASSWORD`  | version-dependent (18+ changed layout) |
| MongoDB    | `mongo:<tag>`    | 27017 | `MONGO_INITDB_ROOT_USERNAME/PASSWORD` | `/data/db`                             |
| Redis      | `redis:<tag>`    | 6379  | `--requirepass` arg                   | `/data`                                |
| SQLite     | — (local file)   | —     | —                                     | user-chosen path                       |

- Versions come from Docker Hub tags API, filtered to stable semver tags, cached.
- Readiness probe per engine (real connect + ping), not just "container running".

### 5.3 Docker conventions

- Labels: `dpilot.managed=true`, `dpilot.engine`, `dpilot.instance=<id>` — Dpilot only manages labelled containers.
- Named volumes `dpilot_<instance>_data` so data survives container removal.
- Port binding on `127.0.0.1` by default; free-port detection and suggestion.
- Transport detection order: `DOCKER_HOST` → Windows npipe (`dockerDesktopLinuxEngine`, `docker_engine`) → `/var/run/docker.sock` → Docker context. Fallback: `docker` CLI via `Bun.spawn` with argument arrays (never a shell string).

### 5.4 Local store (`~/.dpilot/dpilot.db`)

Tables: `instances`, `connections`, `query_history`, `saved_queries`, `settings`.
Passwords are encrypted with AES-GCM using a key in `~/.dpilot/key` (user-only file permissions). OS keychain integration later.

## 6. API Outline

REST under `/api` (JSON, Zod validated):

```
GET    /health                         server + docker status
GET    /docker/status
GET    /catalog/engines                engines + capabilities
GET    /catalog/engines/:id/versions
POST   /instances                      create container (pull → create → start → probe)
GET    /instances | /instances/:id
POST   /instances/:id/start|stop|restart
DELETE /instances/:id?removeVolume=
GET    /instances/:id/compose          docker-compose.yml export
POST   /instances/:id/snapshot         volume snapshot / clone
CRUD   /connections                    saved profiles (external servers only)
POST   /connections/test
GET    /targets                        Dpilot servers + saved connections
GET    /c/:target/info | /variables    target = s.<server name> | c.<connection id>
GET    /c/:conn/databases              (+ POST create, DELETE drop, PATCH settings)
GET    /c/:conn/db/:db/tables          (+ create/alter/rename/drop)
GET    /c/:conn/db/:db/tables/:t       columns, indexes, FKs, triggers, checks
GET    /c/:conn/db/:db/tables/:t/rows  paging, sort, filter, search
POST|PATCH|DELETE .../rows
GET    /c/:conn/db/:db/erd             schema graph
CRUD   /c/:conn/db/:db/views|procedures|functions|triggers
POST   /c/:conn/query                  execute (multi-statement), explain
POST   /c/:conn/query/:qid/cancel
GET    /c/:conn/variables | /processlist | /users
POST   /c/:conn/export | /import       streamed
POST   /c/:conn/backup | /restore
CRUD   /history | /saved-queries
```

WebSocket channels: `pull-progress`, `instance-logs`, `instance-stats`, `query-progress`, `import-export-progress`.

Dpilot servers are live targets (`s.<name>`), read from Docker each time, not stored connection
rows; only external servers are saved. See
[the M2 design](superpowers/specs/2026-11-15-m2-connections-design.md).

## 7. Security

- Bind `127.0.0.1` only; random session token generated at startup and passed via the opened URL, then stored in an HttpOnly cookie.
- Strict `Origin`/`Host` checks (blocks DNS-rebinding and CSRF from other sites).
- Never build shell strings; Docker via API, identifiers quoted, values parameterized.
- Destructive-action confirmations (DROP, TRUNCATE, DELETE/UPDATE without WHERE, remove volume).
- Optional read-only mode per connection.
- Secrets never logged; redact in query history where possible.

## 8. Frontend Layout

- **Sidebar:** instances & connections tree → databases → tables / views / routines.
- **Home:** Docker status, instances (status, port, version, CPU/mem), "New database" wizard.
- **Table view tabs:** Data · Structure · Indexes · Foreign keys · Triggers · DDL.
- **SQL editor:** tabs, autocomplete, run selection, multiple result sets, explain, history, saved queries, file upload.
- **ERD view:** auto-layout, FK edges, export PNG/SVG.
- **Mongo view:** collections, JSON document editor, filter builder. **Redis view:** key browser by type, TTL.

## 9. Feature × Engine Matrix (target)

| Feature                    | MySQL/MariaDB  | Postgres       | SQLite              | MongoDB              | Redis           |
| -------------------------- | -------------- | -------------- | ------------------- | -------------------- | --------------- |
| Docker provisioning        | ✅             | ✅             | n/a                 | ✅                   | ✅              |
| Databases / schemas        | ✅             | ✅ (+schemas)  | file                | ✅                   | db index        |
| Tables / columns / indexes | ✅             | ✅             | ✅ (limited ALTER*) | collections, indexes | —               |
| Foreign keys / ERD         | ✅             | ✅             | ✅                  | —                    | —               |
| Views / procs / functions  | ✅             | ✅             | views only          | —                    | —               |
| Triggers                   | ✅             | ✅             | ✅                  | —                    | —               |
| Storage engine / collation | ✅             | collation      | —                   | —                    | —               |
| Users & privileges         | ✅             | ✅ (roles)     | —                   | ✅                   | ACL             |
| SQL editor                 | ✅             | ✅             | ✅                  | shell-like query     | command console |
| Import/Export              | SQL, CSV, JSON | SQL, CSV, JSON | SQL, CSV, JSON      | JSON, CSV            | JSON            |
| Backup/restore             | dump           | dump           | file copy           | dump                 | RDB             |

\* SQLite ALTER limitations handled via the table-rebuild pattern.

## 10. Milestones

| #   | Milestone                  | Scope                                                                                                                                                                | Done when                                                                 |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| M0  | Scaffold & spikes          | Workspaces, Hono + React wiring, lint/test, CI; spikes: Docker npipe from Bun on Windows, `Bun.sql` MySQL/PG metadata + cancel, `--compile` with embedded web assets | `bun dev` runs both apps; `dpilot` binary serves UI; spike notes recorded |
| M1  | Docker & instances         | Docker status, engine catalog, version list, create with pull progress, start/stop/remove, logs, stats, ports, volumes, compose export                               | Create a MySQL & Postgres instance from the UI and see it healthy         |
| M2  | Connections & explorer     | Local store, encrypted profiles, external connections, test connection, sidebar tree, server info, variables                                                         | Connect to both an instance and an external server                        |
| M3  | Data browsing & SQL editor | Paged grid, sort/filter/search, CRUD, BLOB handling, editor with autocomplete, multi-result, cancel, history, saved queries, file execution                          | Browse/edit rows and run scripts on MySQL/MariaDB/PG/SQLite               |
| M4  | Schema management          | Tables, columns (types, defaults, generated, checks, collation, comments), indexes (incl. full-text), FKs, triggers, SQL preview                                     | Full table designer for SQL engines                                       |
| M5  | Relationships & routines   | ERD, schema print, views, procedures, functions, execution with params                                                                                               | ERD renders; routines CRUD + execute                                      |
| M6  | Import/Export & backup     | SQL/CSV/JSON export (structure, data, full DB, routines), SQL/CSV/JSON import (streamed), backup/restore, snapshots/clone                                            | Round-trip export→import of a full DB                                     |
| M7  | Admin                      | Users & privileges, process list + kill, server status                                                                                                               | Manage users per engine                                                   |
| M8  | MongoDB & Redis            | Document and key-value adapters + UIs                                                                                                                                | Provision, browse and edit both                                           |
| M9  | Release                    | Cross-platform binaries (win/mac/linux), `dpilot doctor`, docs                                                                                                       | Tagged release with binaries                                              |

## 11. Testing Strategy

- **Unit (`bun test`):** DDL builders per dialect, identifier quoting, filter→SQL compilation, catalog logic.
- **Integration:** adapters against real containers started by the test harness (skipped when Docker is unavailable).
- **API:** Hono `app.request()` tests with a fake Docker transport.
- **E2E (later):** Playwright for key flows (create instance → create table → insert → export).

## 12. Risks & Open Questions

- **Windows Docker transport from Bun** (named pipe support in Bun `fetch`/`node:http`) — validate in M0; CLI fallback ready.
- **`Bun.sql` coverage** for multi-statement scripts, stored-procedure bodies, query cancel and streaming — validate in M0; swap to `mysql2`/`pg` behind the adapter if needed.
- **Embedding the Vite build in a compiled binary** — validate in M0.
- **Large data** — always stream/paginate; cap result sets in the editor with "load more".
- **Postgres image data-path changes (v18+)** — catalog must be version-aware.
- **Licensing of images** — Dpilot only pulls official images; users accept upstream licenses.
