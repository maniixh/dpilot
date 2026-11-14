import type {
  DatabaseEntry,
  ObjectGroups,
  SchemaEntry,
  ServerInfo,
  ServerVariable,
  TargetErrorCode,
} from "@dpilot/shared";
import type { ConnectionConfig } from "../connections/types.ts";

export interface SqlClient {
  /** Runs one statement with positional parameters; never interpolate identifiers. */
  query(text: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

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

export class TargetError extends Error {
  override name = "TargetError";
  constructor(
    readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
  }
}
