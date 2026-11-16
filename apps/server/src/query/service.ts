import {
  type ConfirmationRequired,
  type Dialect,
  destructiveReasons,
  type HistoryEntry,
  type QueryRequest,
  type QueryRun,
  type SqlStatement,
  splitStatements,
  type TargetId,
} from "@dpilot/shared";
import type { ConnectionConfig } from "../connections/types.ts";
import { classifyError } from "../engines/errors.ts";
import { type AdapterContext, DataError } from "../engines/types.ts";
import type { HistoryStore } from "../store/types.ts";
import { refuseNonReads, runScript } from "./runner.ts";
import type { QueryService, SqlSession, SqlSessionFactory } from "./types.ts";

export interface QueryServiceDeps {
  resolve: (target: TargetId) => Promise<{ config: ConnectionConfig; ctx: AdapterContext }>;
  sessions: SqlSessionFactory;
  history: HistoryStore;
  /** Milliseconds, as `Date.now`. */
  now: () => number;
  /** A session unused for this long is closed by `sweep`. */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 600_000;
const MAX_CONFIRMED_SQL_CHARS = 2000;
const MAX_TABS = 10;

interface ActiveRun {
  runId: string;
  cancelled: boolean;
  session: SqlSession | null;
  cancelSettled: Promise<void> | null;
}

interface TabEntry {
  key: string;
  target: TargetId;
  session: SqlSession | null;
  database: string | null;
  run: ActiveRun | null;
  /** A kill still travelling to the server; nothing may execute on the session until it lands. */
  pendingCancel: Promise<void> | null;
  lastUsed: number;
  closed: boolean;
}

const ignore = () => undefined;

function dialectOf(config: ConnectionConfig): Dialect {
  return config.engine === "postgres" ? "postgres" : "mysql";
}

function needingConfirmation(
  statements: SqlStatement[],
  dialect: Dialect,
): ConfirmationRequired["statements"] {
  return statements.flatMap((statement, index) => {
    const reasons = destructiveReasons(statement.text, dialect);
    return reasons.length === 0
      ? []
      : [{ index, sql: statement.text.slice(0, MAX_CONFIRMED_SQL_CHARS), reasons }];
  });
}

function historyOutcome(run: Omit<QueryRun, "runId">): Pick<HistoryEntry, "outcome" | "error"> {
  const failed = run.outcomes.find((outcome) => outcome.kind === "error");
  const error = failed?.kind === "error" ? failed.message : null;
  if (run.stopped === "cancelled") return { outcome: "cancelled", error };
  return run.stopped === "error" ? { outcome: "error", error } : { outcome: "ok", error };
}

export function createQueryService(deps: QueryServiceDeps): QueryService {
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const tabs = new Map<string, TabEntry>();

  function tabFor(target: TargetId, tab: string): TabEntry {
    const key = `${target}\u0000${tab}`;
    let entry = tabs.get(key);
    if (!entry) {
      const open = [...tabs.values()].filter((candidate) => candidate.target === target);
      if (open.length >= MAX_TABS) {
        throw new DataError("invalid_request", `At most ${MAX_TABS} tabs can run queries at once.`);
      }
      entry = {
        key,
        target,
        session: null,
        database: null,
        run: null,
        pendingCancel: null,
        lastUsed: deps.now(),
        closed: false,
      };
      tabs.set(key, entry);
    }
    return entry;
  }

  /** Removes the entry synchronously, then stops any run and closes the session. */
  async function dispose(entry: TabEntry): Promise<void> {
    entry.closed = true;
    if (tabs.get(entry.key) === entry) tabs.delete(entry.key);
    const { session } = entry;
    entry.session = null;
    if (entry.run) entry.run.cancelled = true;
    if (session === null) return;
    if (entry.run) await session.cancel().catch(ignore);
    await session.close().catch(ignore);
  }

  async function sessionFor(
    entry: TabEntry,
    config: ConnectionConfig,
    database: string | null,
  ): Promise<SqlSession> {
    if (entry.session !== null && entry.database === database) return entry.session;
    if (entry.session !== null) {
      const stale = entry.session;
      entry.session = null;
      await stale.close().catch(ignore);
    }
    const effective =
      database ?? config.database ?? (config.engine === "postgres" ? "postgres" : null);
    const session = await deps.sessions(config, effective);
    if (entry.closed) {
      await session.close().catch(ignore);
      throw new DataError("invalid_request", "This tab was closed.");
    }
    entry.session = session;
    entry.database = database;
    return session;
  }

  function record(
    target: TargetId,
    request: QueryRequest,
    startedAt: number,
    result: Pick<HistoryEntry, "outcome" | "error" | "statements" | "rowsAffected">,
  ): void {
    try {
      deps.history.add({
        target,
        database: request.database,
        sql: request.sql,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Math.max(0, deps.now() - startedAt),
        ...result,
      });
    } catch (error) {
      console.error("Could not record query history", error);
    }
  }

  async function execute(
    target: TargetId,
    request: QueryRequest,
    entry: TabEntry,
    active: ActiveRun,
    resolved: { config: ConnectionConfig; ctx: AdapterContext },
    statements: SqlStatement[],
  ): Promise<QueryRun> {
    const { config, ctx } = resolved;
    const startedAt = deps.now();
    let session: SqlSession;
    try {
      if (entry.pendingCancel !== null) await entry.pendingCancel.catch(ignore);
      session = await sessionFor(entry, config, request.database);
    } catch (error) {
      if (error instanceof DataError) throw error;
      const failure = classifyError(error, config, ctx);
      record(target, request, startedAt, {
        outcome: "error",
        error: failure.message,
        statements: 0,
        rowsAffected: 0,
      });
      throw failure;
    }
    active.session = session;

    let result: Omit<QueryRun, "runId">;
    let lost = false;
    try {
      result = await runScript(session, statements, {
        maxRows: request.maxRows,
        readOnly: config.readOnly,
        dialect: dialectOf(config),
        isCancelled: () => active.cancelled,
        now: deps.now,
        onConnectionLost: () => {
          lost = true;
        },
      });
    } catch (error) {
      if (entry.session === session) entry.session = null;
      await session.close().catch(ignore);
      throw error;
    } finally {
      if (entry.run === active) entry.run = null;
      entry.lastUsed = deps.now();
    }
    if (lost) {
      if (entry.session === session) entry.session = null;
      await session.close().catch(ignore);
    }
    // The tab is free, but the answer waits for the kill so the caller sees a settled server.
    if (active.cancelSettled !== null) await active.cancelSettled.catch(ignore);
    record(target, request, startedAt, {
      ...historyOutcome(result),
      statements: result.summary.statements,
      rowsAffected: result.summary.affected,
    });
    return { runId: request.runId, ...result };
  }

  return {
    async run(target, request) {
      const resolved = await deps.resolve(target);
      const dialect = dialectOf(resolved.config);
      const statements = splitStatements(request.sql, dialect);
      if (statements.length === 0) throw new DataError("invalid_request", "Nothing to run.");
      if (!request.confirmed) {
        const pending = needingConfirmation(statements, dialect);
        if (pending.length > 0) {
          throw new DataError(
            "confirmation_required",
            "These statements change or remove data. Confirm to run them.",
            pending,
          );
        }
      }
      if (resolved.config.readOnly) refuseNonReads(statements, dialect);
      const duplicate = [...tabs.values()].some(
        (candidate) => candidate.target === target && candidate.run?.runId === request.runId,
      );
      if (duplicate) throw new DataError("invalid_request", "That run id is already in use.");

      const entry = tabFor(target, request.tab);
      if (entry.run !== null) {
        throw new DataError("busy", "This tab is still running a query.");
      }
      const active: ActiveRun = {
        runId: request.runId,
        cancelled: false,
        session: null,
        cancelSettled: null,
      };
      entry.run = active;
      try {
        return await execute(target, request, entry, active, resolved, statements);
      } finally {
        if (entry.run === active) entry.run = null;
        if (entry.session === null && tabs.get(entry.key) === entry) tabs.delete(entry.key);
      }
    },

    async cancel(target, runId) {
      const entry = [...tabs.values()].find(
        (candidate) => candidate.target === target && candidate.run?.runId === runId,
      );
      const active = entry?.run;
      if (entry === undefined || !active) {
        throw new DataError("run_not_found", "No query with that id is running.");
      }
      active.cancelled = true;
      if (active.session === null) return;
      const settled = active.session.cancel();
      active.cancelSettled = settled;
      entry.pendingCancel = settled;
      await settled;
    },

    async closeTab(target, tab) {
      const entry = tabs.get(`${target}\u0000${tab}`);
      if (entry) await dispose(entry);
    },

    async closeTarget(target) {
      const entries = [...tabs.values()].filter((entry) => entry.target === target);
      await Promise.all(entries.map(dispose));
    },

    async closeAll() {
      await Promise.all([...tabs.values()].map(dispose));
    },

    async sweep() {
      const cutoff = deps.now() - idleMs;
      const idle = [...tabs.values()].filter(
        (entry) => entry.run === null && entry.lastUsed < cutoff,
      );
      await Promise.all(idle.map(dispose));
    },
  };
}
