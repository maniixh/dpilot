import type { QueryRequest, QueryRun, TargetId } from "@dpilot/shared";
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

export interface QueryService {
  /** Runs a script on the tab's session; rejects with DataError/TargetError on refusal. */
  run(target: TargetId, request: QueryRequest): Promise<QueryRun>;
  /** Stops the run's in-flight statement; resolves once the server has acted on it. */
  cancel(target: TargetId, runId: string): Promise<void>;
  closeTab(target: TargetId, tab: string): Promise<void>;
  closeTarget(target: TargetId): Promise<void>;
  /** Closes every session; for server shutdown. */
  closeAll(): Promise<void>;
  /** Closes sessions that have been idle too long. */
  sweep(): Promise<void>;
}
