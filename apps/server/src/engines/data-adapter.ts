import type { ColumnMeta, Dialect, TableMeta, TableRef } from "@dpilot/shared";
import type { ConnectionConfig } from "../connections/types.ts";
import { encodeCell } from "./cells.ts";
import {
  aggregate,
  countRows,
  deleteRow,
  insertRow,
  lockRow,
  selectCell,
  selectPage,
  updateCell,
  updateRow,
} from "./dialect.ts";
import { classifyError } from "./errors.ts";
import {
  type AdapterContext,
  type DataAdapter,
  DataError,
  type SqlClient,
  type SqlTransaction,
  TargetError,
} from "./types.ts";

const CACHE_MS = 30_000;
const MAX_COMPLETION_TABLES = 2000;

const REASON_VIEW = "This is a view.";
const REASON_NO_KEY = "This table has no primary key, so rows can't be told apart.";
const REASON_BINARY_KEY = "Binary primary keys aren't supported for editing.";
const REASON_READ_ONLY = "This connection is read-only.";

export interface CatalogTable {
  kind: "table" | "view";
  columns: ColumnMeta[];
  /** Unique keys without prefix or expression parts, the primary key first. */
  uniqueKeys: string[][];
}

export interface CompletionRow {
  tableName: string;
  columnName: string;
}

/** The engine-specific half of a data adapter: clients, catalog queries and name resolution. */
export interface DataCatalog {
  dialect: Dialect;
  /** True when UPDATE reports only rows whose values changed (MySQL), so 0 can mean "unchanged". */
  updateCountsChangesOnly: boolean;
  client(db: string): SqlClient;
  /** Fills in the schema (Postgres) or database (MySQL) a bare table reference means. */
  resolve(db: string, ref: TableRef): TableRef;
  /** `ref` is already resolved; null when the table does not exist. */
  describe(client: SqlClient, db: string, ref: TableRef): Promise<CatalogTable | null>;
  completion(client: SqlClient, db: string, schema: string | null): Promise<CompletionRow[]>;
  close(): Promise<void>;
}

/** The first unique key whose columns are all NOT NULL, found in the catalog. */
function usableKey(found: CatalogTable): string[] {
  const nullable = new Map(found.columns.map((column) => [column.name, column.nullable]));
  return found.uniqueKeys.find((key) => key.every((name) => nullable.get(name) === false)) ?? [];
}

function notEditableReason(found: CatalogTable, key: string[], readOnly: boolean): string | null {
  if (found.kind === "view") return REASON_VIEW;
  if (key.length === 0) return REASON_NO_KEY;
  const binary = key.some(
    (name) => found.columns.find((column) => column.name === name)?.kind === "binary",
  );
  if (binary) return REASON_BINARY_KEY;
  return readOnly ? REASON_READ_ONLY : null;
}

function toTableMeta(found: CatalogTable, readOnly: boolean): TableMeta {
  const primaryKey = found.kind === "view" ? [] : usableKey(found);
  const readOnlyReason = notEditableReason(found, primaryKey, readOnly);
  return {
    kind: found.kind,
    columns: found.columns,
    primaryKey,
    editable: readOnlyReason === null,
    readOnlyReason,
  };
}

function keyText(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function cellBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value === null || value === undefined) {
    throw new DataError("invalid_request", "This cell is empty (NULL).");
  }
  return new TextEncoder().encode(typeof value === "string" ? value : String(value));
}

/** Everything the grid does to a table, shared by MySQL and Postgres. */
export function buildDataAdapter(
  config: ConnectionConfig,
  ctx: AdapterContext,
  catalog: DataCatalog,
): DataAdapter {
  const { dialect } = catalog;
  const cache = new Map<string, { meta: TableMeta; expires: number }>();

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof DataError) throw error;
      throw classifyError(error, config, ctx);
    }
  };

  const describe = async (db: string, ref: TableRef) => {
    const resolved = catalog.resolve(db, ref);
    const cacheKey = JSON.stringify([db, resolved.schema, resolved.table]);
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return { ref: resolved, meta: cached.meta };
    const found = await catalog.describe(catalog.client(db), db, resolved);
    if (found === null) {
      throw new TargetError("target_not_found", `No table named ${ref.table}.`);
    }
    const meta = toTableMeta(found, ctx.readOnly);
    cache.set(cacheKey, { meta, expires: Date.now() + CACHE_MS });
    return { ref: resolved, meta };
  };

  /** Resolves a table for a write; nothing is sent to the database on a read-only connection. */
  const writable = async (db: string, ref: TableRef) => {
    if (ctx.readOnly) throw new DataError("read_only", REASON_READ_ONLY);
    const described = await describe(db, ref);
    if (!described.meta.editable) {
      throw new DataError("not_editable", described.meta.readOnlyReason ?? REASON_NO_KEY);
    }
    return described;
  };

  const mutate = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await guard(fn);
    } finally {
      cache.clear();
    }
  };

  const lockOne = async (
    tx: SqlTransaction,
    lock: { text: string; params: readonly unknown[] },
  ) => {
    const locked = await tx.execute(lock.text, lock.params);
    if (locked.rows.length === 0)
      throw new DataError("row_not_found", "That row no longer exists.");
    if (locked.rows.length > 1) {
      throw new DataError("key_not_unique", "The key matches more than one row.");
    }
  };

  /** The row is locked and known to exist, so an unchanged-value UPDATE may report 0 on MySQL. */
  const changeOne = async (
    tx: SqlTransaction,
    statement: { text: string; params: readonly unknown[] },
    isUpdate: boolean,
  ) => {
    const { affected } = await tx.execute(statement.text, statement.params);
    const unchanged = isUpdate && catalog.updateCountsChangesOnly && affected === 0;
    if (affected !== 1 && !unchanged) {
      throw new DataError("row_not_found", "That row no longer exists.");
    }
  };

  return {
    table: (db, ref) => guard(async () => (await describe(db, ref)).meta),

    rows: (db, query) =>
      guard(async () => {
        const { ref, meta } = await describe(db, query.ref);
        const built = selectPage(dialect, meta, ref, query);
        const result = await catalog.client(db).execute(built.text, built.params);
        const width = meta.columns.length;
        return {
          rows: result.rows.map((row) => row.slice(0, width).map(encodeCell)),
          keys: meta.editable
            ? result.rows.map((row) =>
                Object.fromEntries(
                  meta.primaryKey.map((name, index) => [name, keyText(row[width + index])]),
                ),
              )
            : null,
        };
      }),

    count: (db, request) =>
      guard(async () => {
        const { ref, meta } = await describe(db, request.ref);
        const built = countRows(dialect, meta, ref, request);
        const result = await catalog.client(db).execute(built.text, built.params);
        return Number(result.rows[0]?.[0] ?? 0);
      }),

    aggregate: (db, request) =>
      guard(async () => {
        const { ref, meta } = await describe(db, request.ref);
        const built = aggregate(dialect, meta, ref, request);
        const result = await catalog.client(db).execute(built.text, built.params);
        return { values: (result.rows[0] ?? []).map(encodeCell) };
      }),

    insert: (db, request) =>
      mutate(async () => {
        const { ref, meta } = await writable(db, request.ref);
        const built = insertRow(dialect, meta, ref, request.values);
        const result = await catalog.client(db).execute(built.text, built.params);
        return { affected: result.affected ?? 0 };
      }),

    update: (db, request) =>
      mutate(async () => {
        const { ref, meta } = await writable(db, request.ref);
        const lock = lockRow(dialect, meta, ref, request.key);
        const update = updateRow(dialect, meta, ref, request.key, request.values);
        await catalog.client(db).transaction(async (tx) => {
          await lockOne(tx, lock);
          await changeOne(tx, update, true);
        });
        return { affected: 1 };
      }),

    remove: (db, request) =>
      mutate(async () => {
        const { ref, meta } = await writable(db, request.ref);
        const statements = request.keys.map((key) => ({
          lock: lockRow(dialect, meta, ref, key),
          remove: deleteRow(dialect, meta, ref, key),
        }));
        await catalog.client(db).transaction(async (tx) => {
          for (const { lock, remove } of statements) {
            await lockOne(tx, lock);
            await changeOne(tx, remove, false);
          }
        });
        return { affected: statements.length };
      }),

    readCell: (db, ref, key, column) =>
      guard(async () => {
        const described = await describe(db, ref);
        const built = selectCell(dialect, described.meta, described.ref, key, column);
        const result = await catalog.client(db).execute(built.text, built.params);
        const [row] = result.rows;
        if (row === undefined) throw new DataError("row_not_found", "That row no longer exists.");
        return cellBytes(row[0]);
      }),

    writeCell: (db, ref, key, column, bytes) =>
      mutate(async () => {
        const described = await writable(db, ref);
        const lock = lockRow(dialect, described.meta, described.ref, key);
        const write = updateCell(dialect, described.meta, described.ref, key, column, bytes);
        await catalog.client(db).transaction(async (tx) => {
          await lockOne(tx, lock);
          await changeOne(tx, write, true);
        });
        return { affected: 1 };
      }),

    completion: (db, schema) =>
      guard(async () => {
        const rows = await catalog.completion(catalog.client(db), db, schema);
        const tables = new Map<string, string[]>();
        for (const { tableName, columnName } of rows) {
          let columns = tables.get(tableName);
          if (columns === undefined) {
            if (tables.size >= MAX_COMPLETION_TABLES) continue;
            columns = [];
            tables.set(tableName, columns);
          }
          columns.push(columnName);
        }
        return Object.fromEntries(tables);
      }),

    close: () => catalog.close(),
  };
}
