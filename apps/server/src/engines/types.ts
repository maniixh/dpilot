import type {
  AggregateRequest,
  AggregateResult,
  CountRequest,
  DatabaseEntry,
  DataErrorCode,
  DeleteRequest,
  EditResult,
  InsertRequest,
  ObjectGroups,
  RowKey,
  RowsPage,
  RowsQuery,
  SchemaEntry,
  ServerInfo,
  ServerVariable,
  TableMeta,
  TableRef,
  TargetErrorCode,
  UpdateRequest,
} from "@dpilot/shared";
import type { ConnectionConfig } from "../connections/types.ts";

export interface SqlResult {
  columns: string[];
  /** Rows as arrays, so duplicate column names survive. */
  rows: unknown[][];
  /** The command tag (Postgres only). */
  command: string | null;
  affected: number | null;
}

export interface SqlClient {
  /** Runs one statement with positional parameters; never interpolate identifiers. */
  query(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** Like `query`, but keeps row order, duplicate columns and the command outcome. */
  execute(text: string, params?: readonly unknown[]): Promise<SqlResult>;
  /** Runs `fn` in one transaction; throwing rolls it back. */
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type SqlTransaction = Pick<SqlClient, "query" | "execute">;

/** Opens a client for `config`, bound to `database` (null = the engine's default). */
export type SqlClientFactory = (config: ConnectionConfig, database: string | null) => SqlClient;

export interface ExplorerAdapter {
  info(): Promise<ServerInfo>;
  variables(): Promise<ServerVariable[]>;
  databases(): Promise<DatabaseEntry[]>;
  /** Postgres only; MySQL has no schemas below a database. */
  schemas(db: string): Promise<SchemaEntry[]>;
  objects(db: string, schema: string | null): Promise<ObjectGroups>;
  close(): Promise<void>;
}

export interface AdapterContext {
  /** True for servers Dpilot created, which changes the auth failure hint. */
  managed: boolean;
  /** True when the connection must never change data. */
  readOnly: boolean;
}

export interface DataAdapter {
  table(db: string, ref: TableRef): Promise<TableMeta>;
  rows(db: string, query: RowsQuery): Promise<RowsPage>;
  count(db: string, request: CountRequest): Promise<number>;
  aggregate(db: string, request: AggregateRequest): Promise<AggregateResult>;
  insert(db: string, request: InsertRequest): Promise<EditResult>;
  update(db: string, request: UpdateRequest): Promise<EditResult>;
  remove(db: string, request: DeleteRequest): Promise<EditResult>;
  readCell(db: string, ref: TableRef, key: RowKey, column: string): Promise<Uint8Array>;
  writeCell(
    db: string,
    ref: TableRef,
    key: RowKey,
    column: string,
    bytes: Uint8Array,
  ): Promise<EditResult>;
  /** Column names per table in the schema (at most 2000 tables). */
  completion(db: string, schema: string | null): Promise<Record<string, string[]>>;
  close(): Promise<void>;
}

export class DataError extends Error {
  override name = "DataError";
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class TargetError extends Error {
  override name = "TargetError";
  constructor(
    readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
  }
}
