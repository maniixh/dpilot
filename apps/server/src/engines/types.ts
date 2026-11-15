import type {
  DatabaseEntry,
  DataErrorCode,
  ObjectGroups,
  SchemaEntry,
  ServerInfo,
  ServerVariable,
  TargetErrorCode,
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
