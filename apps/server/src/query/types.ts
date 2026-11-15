import type { ConnectionConfig } from "../connections/types.ts";
import type { SqlResult } from "../engines/types.ts";

/** One pinned connection: session state (`USE`, `SET`, transactions) persists across runs. */
export interface SqlSession {
  execute(text: string): Promise<SqlResult>;
  /** Stops the statement in flight, if any; resolves once the server has acted on it. */
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export type SqlSessionFactory = (
  config: ConnectionConfig,
  database: string | null,
) => Promise<SqlSession>;
