# M3 Data browsing & SQL editor — design

Date: 2026-11-15 · Branch: `m3-data` · Builds on M2 (connections & explorer)

## Intent

M2 lets people find a database and see what's in it. M3 lets them work with the data:
open a table, page through rows, narrow them down, fix a value, and run SQL — the two
things people open a database tool for most often. Success: someone who just created a
Postgres or MySQL server in Dpilot can browse and edit a table and run a script without
reaching for another tool.

## Goals

- **Data grid (M3a)** for tables and views on MySQL, MariaDB and Postgres:
  paged and virtualised; sort (multi-column); typed filters; quick search across text
  columns; page size; total count; count/sum/avg/min/max over the filtered rows;
  insert, update and delete by primary key; NULL vs empty vs default; dates and JSON
  shown as text; BLOBs shown as size + hex preview with download and upload.
- **SQL editor (M3b):** CodeMirror 6 with dialect highlighting and table/column
  autocomplete; run the selection, the statement at the cursor, or everything;
  one result pane per statement (rows or rows affected); cancel; EXPLAIN; run an
  uploaded `.sql` file; per-tab session so `USE`, `SET` and `BEGIN … COMMIT` carry
  across runs; tabs; history (passwords redacted); saved queries.
- **Safety:** an optional read-only flag per saved connection; a confirmation step
  before destructive statements (DROP, TRUNCATE, DELETE/UPDATE without WHERE, ALTER …
  DROP), enforced by the server, not just the UI.

## Non-goals

- SQLite (moved to a later milestone — it needs a file-picker flow, not a server).
- Table/column/index design (M4), import/export (M6), ER diagrams (M5).
- Streaming result sets to the browser. Results are capped (see Limits).
- Editing rows of tables without a primary key, or with a binary primary key.
- Read-only mode for Dpilot's own servers (they're disposable dev servers).

## Anti-goals

- A grid edit that changes more than the one row the user pointed at.
- Values interpolated into SQL. Values are always bound parameters; identifiers are
  always quoted by one function per dialect, never by hand.
- A "read-only" connection that can still change data through the editor.
- History that stores passwords from `CREATE USER … IDENTIFIED BY '…'`.

## Approaches considered

1. **Hand the whole script to the driver** (`Bun.SQL` runs multi-statement text without
   parameters). Simple, but one error loses every earlier result, no per-statement
   timing, can't confirm destructive statements individually, and MySQL `DELIMITER`
   scripts (procedure bodies) don't work.
2. **Split scripts in Dpilot and run statement by statement on a pinned session.**
   (chosen) A dialect-aware splitter (quotes, comments, dollar quotes, `DELIMITER`) runs
   in both the server and the browser. The server runs each statement in order on one
   reserved connection per editor tab, records an outcome per statement, stops at the
   first error, and can cancel the one in flight. The same splitter finds "the statement
   at the cursor" and drives the destructive-statement check.
3. **Swap to `mysql2`/`pg`** for cursors and streaming. More capability than M3 needs,
   two more dependencies, and the M2 adapter layer is built on `Bun.SQL`. Kept as the
   fallback named in PLAN's risks.

## Spike findings (Bun 1.4.4 against mysql:26 and postgres:18)

- `sql.unsafe(text, params).values()` returns rows as arrays, so duplicate column names
  (`SELECT 1 AS x, 2 AS x`) survive; object rows keep only the last. The result also has
  `.columns` (`name`, numeric `type`), `.command` (Postgres only), `.affectedRows`,
  `.lastInsertRowid` (MySQL).
- Types: Postgres `bigint`/`numeric` → string; MySQL `BIGINT` → number, or string when it
  doesn't fit a double safely; `DECIMAL` → string; dates → `Date` (MySQL `DATETIME`/`DATE`
  read as UTC, so the UTC fields are the stored wall-clock values); `bytea`/`BLOB` →
  `Buffer`; MySQL `JSON` → parsed object, Postgres `json` → object, `jsonb` → string;
  Postgres arrays → JS arrays; `NaN` float8 → `null` (accepted loss).
- Cancel: Postgres `query.cancel()` rejects the query ("canceling statement due to user
  request") within ~0.5 s. MySQL `query.cancel()` does nothing; `KILL QUERY <id>` from a
  second connection works and leaves the session usable.
- `sql.reserve()` pins one connection (session state like `SET @v` persists);
  `sql.begin()` transactions roll back on throw.
- Errors carry `code`, `errno` (MySQL number / Postgres SQLSTATE) and Postgres `position`.

## Design

### Shared contracts (`packages/shared/src/data.ts`, `query.ts`, `sql/*`)

- `CellValue = null | boolean | number | string | { bytes: { size: number; hex: string;
  truncated: boolean } }` — hex preview of the first 64 bytes. Dates, JSON, arrays,
  decimals and integers outside ±2^53 arrive as strings (see cell encoding).
- `RowKey = Record<string, string>` — primary-key values always travel as their exact
  canonical text (never JS numbers), so 64-bit keys round-trip.
- `ColumnKind = "text" | "integer" | "decimal" | "float" | "boolean" | "date" | "datetime"
  | "time" | "json" | "binary" | "other"`.
- `ColumnMeta { name; type (as the catalog spells it); kind; nullable; defaultValue:
  string | null; generated: boolean; autoIncrement: boolean }`.
- `TableMeta { kind: "table" | "view"; columns; primaryKey: string[]; editable: boolean;
  readOnlyReason: string | null }` — `editable` is false for views, tables without a
  primary key, binary primary keys, and read-only connections (reason says which).
- `TableRef { schema: string | null; table: string }`.
- `RowsQuery { ref; filters: Filter[]; search: string | null; sort: {column; direction}[];
  offset; limit (1–1000) }` with `Filter` a discriminated union on `op`:
  `eq ne lt le gt ge like not_like` (value string), `in not_in` (1–100 strings),
  `is_null not_null` (no value).
- `AggregateRequest { ref; filters; search; aggregates: {fn: count|sum|avg|min|max;
  column: string | null}[] (1–10) }` — `column` null only with `count`.
- Edits: `EditValue = { set: string | null } | { useDefault: true }`;
  `InsertRequest { ref; values: Record<column, EditValue> }`,
  `UpdateRequest { ref; key: RowKey; values }`,
  `DeleteRequest { ref; keys: RowKey[] (1–500) }`. Edits are last-write-wins (no
  original-value check); a key must name exactly the primary-key columns.
- Query: `QueryRequest { runId (uuid, client-generated so Cancel works mid-run); sql
  (≤ 16 MB); database: string | null; tab (uuid); maxRows (1–10 000, default 1000);
  confirmed: boolean }`;
  `QueryRun { runId; outcomes: StatementOutcome[]; omitted: number; summary {statements;
  succeeded; affected}; stopped: null | "error" | "cancelled"; durationMs }`;
  `StatementOutcome = { index; sql (≤ 2000 chars); durationMs } &
  ({ kind: "rows"; columns: {name; kind}[]; rows: CellValue[][]; truncated: boolean }
  | { kind: "affected"; command: string | null; affected: number }
  | { kind: "error"; message; position: number | null })`.
  At most 100 outcomes are kept (first 50 + last 50); `omitted` counts the rest.
- `SQL tools` (pure, run in server and browser):
  `splitStatements(sql, dialect) → { text; start; end }[]`;
  `statementAt(statements, offset)`; `tokenize(text, dialect)`;
  `classifyStatement(text, dialect) → "read" | "write" | "ddl" | "transaction" | "session"
  | "unknown"`; `destructiveReasons(text, dialect) → string[]`;
  `redactSql(text)`; `explainSql(dialect, text)`.
  `dialect = "mysql" | "postgres"` (MariaDB uses `mysql`).
  The classifier works on tokens (strings, quoted identifiers, comments and Postgres
  dollar quotes removed; MySQL executable comments `/*! … */` and `/*M! … */` are
  treated as code). It is conservative: `read` only when the statement starts with
  `SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`, `DESCRIBE`/`DESC`, `EXPLAIN` (without
  `ANALYZE`) and contains no `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`REPLACE`/`CALL`/`DO`/
  `COPY`/`LOCK`, no `INTO` (covers `INTO OUTFILE`/`DUMPFILE`/`SELECT INTO new_table`) and
  no `FOR UPDATE`/`FOR SHARE`. Anything it can't place is `unknown`.
  Destructive reasons: `DROP …`, `TRUNCATE`, `ALTER … DROP`, and every `DELETE`/`UPDATE`
  (including inside a CTE) whose own parenthesis level has no `WHERE` before the
  statement or sub-statement ends. `unknown` statements that contain `DELETE`, `UPDATE`,
  `DROP` or `TRUNCATE` tokens anywhere also get a reason — when unsure, ask.

### Store (migration 2)

- `connections.read_only INTEGER NOT NULL DEFAULT 0`; `SavedConnection.readOnly`,
  `ConnectionInput.readOnly` (optional, default false).
- `query_history (id INTEGER PK, target TEXT, database TEXT NULL, sql TEXT, started_at,
  duration_ms, outcome CHECK IN ('ok','error','cancelled'), statements INT, rows_affected
  INT, error TEXT NULL)`, index on `(target, id DESC)`; capped at 5000 rows (oldest
  pruned on insert). SQL is stored redacted and truncated to 100 KB.
- `saved_queries (id TEXT PK uuid, name TEXT UNIQUE (1–100), target TEXT NULL, database
  TEXT NULL, sql TEXT (≤ 1 MB), created_at, updated_at)`.

### Server

- **Lossless grid reads:** the grid's SELECT list casts every column whose kind is not
  `text`, `integer`, `float`, `boolean` or `binary` to text in the database
  (`CAST(col AS CHAR)` on MySQL, `col::text` on Postgres), so dates keep their exact
  precision and wall-clock meaning, decimals keep every digit, and Postgres arrays,
  ranges and JSON come back in the literal syntax that writes accept (`{1,2}`). The
  primary-key columns are additionally selected as text under aliases (`__k0`, `__k1`…)
  so `RowKey` values are exact. Data and query clients open with `bigint: true`.
- **Cell encoding** (`engines/cells.ts`): `Buffer` → `bytes`; `bigint` → number when
  within ±2^53, else string; non-finite numbers → string; `Date` (editor results only)
  → ISO string; other objects/arrays → `JSON.stringify`. Editor results are display-only
  and may lose sub-millisecond precision; the grid never does. Rows come from `.values()`.
- **Dialect** (`engines/dialect.ts`): `quoteIdent` (backticks doubled / double quotes
  doubled), `qualified(ref)`, placeholder style (`?` / `$n`), `LIKE` (MySQL) vs `ILIKE`
  (Postgres) for search, escaping `%`, `_` and `\` in search terms with `ESCAPE '\'`.
  Builders for SELECT page, COUNT/aggregates, INSERT, UPDATE, DELETE return
  `{ text; params }`. Every identifier must match a column from `TableMeta`; unknown
  columns are `invalid_request` before any SQL is built. Search covers `text`-kind
  columns only; Postgres casts nothing, MySQL relies on collation.
- **Data adapter** (`DataAdapter` beside `ExplorerAdapter`, same per-engine files or
  `mysql-data.ts`/`postgres-data.ts`): `table(db, ref)`, `rows(db, query)`,
  `aggregate(db, request)`, `insert/update/delete(db, …)`, `readCell(db, ref, key,
  column) → Uint8Array | string`, `writeCell(db, ref, key, column, bytes)`,
  `completion(db, schema) → Record<table, column[]>` (≤ 2000 tables). Metadata comes from
  `information_schema` (MySQL) and `pg_catalog`/`information_schema` (Postgres). Table
  metadata is cached per adapter for 30 s and dropped after any edit.
- **Edits** run in a transaction: `SELECT 1 … WHERE <pk> FOR UPDATE` locks the row
  first; anything other than exactly one row → roll back with `row_not_found` /
  `key_not_unique`; then the UPDATE/DELETE, whose affected count must be 1 (else roll
  back). Key and value parameters are bound as text (or null); on Postgres every
  parameter is cast to its column type (`$1::<format_type>`, the type text taken from
  the catalog, never from the request); MySQL converts text itself. Filters use the same
  casts. Binary columns accept uploads only through `writeCell`.
- **SqlClient additions:** `execute(text, params?) → { columns: { name }[]; rows:
  unknown[][]; command: string | null; affected: number | null }` (uses `.values()`),
  `transaction(fn)` (via `sql.begin`).
- **Query sessions** (`query/service.ts`): `SqlSessionFactory(config, database) →
  Promise<SqlSession>` with `execute`, `cancel`, `close`. The Bun session pins one
  connection with `reserve()`, records MySQL's `CONNECTION_ID()` at open, and cancels
  with `query.cancel()` (Postgres) or `KILL QUERY` through a short-lived second client
  (MySQL). `QueryService` keeps one session per `(target, tab)` (database change reopens
  it), closes sessions idle for 10 minutes and when a target is forgotten, rejects a
  second run on a busy tab (`busy`), and exposes `cancel(target, runId)`.
- **Cancel** sets the run's cancelled flag (no further statement starts) and, only while
  a statement of that run is in flight, cancels it. The run's response is not sent and
  the tab not freed until the cancel request (including MySQL's `KILL QUERY`) has
  settled, so a late kill can't hit the next run. Unknown or finished `runId` → 404.
- **Running a script:** split → if not `confirmed` and any statement has a destructive
  reason → `confirmation_required` with the list (no statement runs).
- **Read-only connections** (a guard rail against mistakes, not a security boundary —
  the UI and docs recommend a database user with only SELECT for real protection):
  every statement must classify as `read`, otherwise `read_only` before anything runs
  (so `SET`, `BEGIN`, `COMMIT`, `USE`, `CALL` are all refused; the database is chosen in
  the toolbar instead). Each statement then runs inside a server-owned
  `START TRANSACTION READ ONLY` (MySQL) / `BEGIN READ ONLY` (Postgres) that is rolled
  back afterwards, so functions with side effects called from a SELECT fail too. The
  grid's write routes answer `read_only`.
- Rows beyond `maxRows` are dropped and the outcome is `truncated`. Stop at the first
  error. Every run is written to history.
- **Errors:** new `DataError` codes — `invalid_request` 400 (unknown column, bad
  filter), `read_only` 403, `not_editable` 409, `row_not_found` 404,
  `key_not_unique` 409, `confirmation_required` 409 (body carries `statements:
  {index; reason}[]`), `busy` 409, `run_not_found` 404. Driver errors in the grid map
  through the existing `TargetError` path (`query_failed` keeps the driver's message).

### Routes (under `/api/c/:target`)

```
GET    /db/:db/table?schema=&table=        TableMeta
POST   /db/:db/rows                        RowsQuery → { rows: CellValue[][]; keys: RowKey[] | null }
POST   /db/:db/rows/count                  filters + search → { count }
POST   /db/:db/rows/aggregate              AggregateRequest → { values: CellValue[] }
POST   /db/:db/rows/insert|update|delete   → { affected }
GET    /db/:db/cell?schema&table&column&key=<json>    raw bytes (attachment)
PUT    /db/:db/cell?schema&table&column&key=<json>    raw body ≤ 16 MB
GET    /db/:db/completion?schema=          { tables: Record<string, string[]> }
POST   /query                              QueryRequest → QueryRun
POST   /query/:runId/cancel                204
DELETE /sessions/:tab                      204 (tab closed)
```
Plus `GET /api/history?target=&search=&before=&limit=`, `DELETE /api/history`,
`DELETE /api/history/:id`, and `GET/POST /api/saved-queries`,
`PATCH/DELETE /api/saved-queries/:id`.

### Web

- **Routes:** `/c/:target/db/:db/t/:table` (MySQL) and `/c/:target/db/:db/s/:schema/t/:table`
  (Postgres) open the grid; `/c/:target/sql` opens the editor (database picked in its
  toolbar, `?db=` in the URL). The sidebar's tables and views become links; each target
  gets an "SQL editor" link; the database overview links its tables.
- **Grid** (`features/data/`): TanStack Table for column model + TanStack Virtual for rows.
  Toolbar: search box, "Filter" (rows of column · operator · value), page size
  (50/100/200/500), pager with total ("1–100 of 12 408"), "Add row". Header click sorts
  (shift-click adds a column). Cells render NULL in a muted style, long text clipped
  with the full value in a side panel. Double-click edits a cell; edits collect as
  pending changes ("Save 3 changes" / "Discard"); each save sends one update per row;
  a failed row stays pending with its error. Row checkboxes + "Delete rows" with a
  `<dialog>` confirmation. BLOB cells show `12.4 KB · 89504e47…` with Download and
  Replace. A footer picks an aggregate and a column. A read-only banner states
  `readOnlyReason`.
- **Editor** (`features/sql/`, lazy-loaded route): CodeMirror 6 (`codemirror`,
  `@codemirror/lang-sql` with `MySQL`/`PostgreSQL` dialect and completion schema from
  `/completion`). Tabs (≤ 10, contents in `localStorage`); Ctrl/Cmd+Enter runs the
  selection or the statement at the cursor; Ctrl/Cmd+Shift+Enter runs everything;
  Cancel while running; Explain (current statement); "Run a file" (`.sql`, ≤ 16 MB,
  read in the browser, not loaded into the editor above 1 MB). The results area has one
  tab per outcome, a run summary line, and the error with its position highlighted.
  Destructive statements open a confirmation listing each reason before re-sending with
  `confirmed: true`. Side panel: History (search, re-open into a tab, delete, clear) and
  Saved (save current tab, rename, delete, open).
- **Connection form:** "Read-only" checkbox with a one-line hint.

### Limits

Rows per page ≤ 1000; rows per editor result ≤ 10 000 (default 1000); outcomes kept per
run ≤ 100; script ≤ 16 MB; cell upload ≤ 16 MB; history 5000 entries; tabs 10.

## Left to the builder

- Exact catalog SQL for column metadata (generated/auto-increment detection per engine).
- Whether Bun's Postgres params need explicit casts for every type (integration tests
  decide; the design allows `$n::type`).
- Styling within the existing tokens and components.
