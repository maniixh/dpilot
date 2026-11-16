import { SQL } from "bun";
import type { ConnectionConfig } from "../connections/types.ts";
import { sqlOptions, toSqlResult } from "../engines/bun-sql.ts";
import type { SqlResult } from "../engines/types.ts";
import type { SqlSession, SqlSessionFactory } from "./types.ts";

interface PendingQuery {
  values(): Promise<unknown>;
}

interface Reserved {
  unsafe(text: string): PendingQuery;
  release(): void;
}

/**
 * Cancels from a second connection: MySQL ignores `query.cancel()`, and Postgres' version
 * returns before the server has acted. Resolves once the server has taken the signal.
 */
async function cancelFromSecondConnection(
  config: ConnectionConfig,
  backendId: number,
  database: string | null,
): Promise<void> {
  if (!Number.isSafeInteger(backendId)) throw new Error("Invalid connection id.");
  const canceller = new SQL(sqlOptions(config, database, 1));
  try {
    if (config.engine === "postgres") {
      await canceller.unsafe("SELECT pg_cancel_backend($1)", [backendId]);
    } else {
      // KILL takes no bound parameter; the text is built from a verified integer.
      await canceller.unsafe(`KILL QUERY ${backendId}`);
    }
  } finally {
    await canceller.close();
  }
}

async function backendId(config: ConnectionConfig, reserved: Reserved): Promise<number> {
  const text = config.engine === "postgres" ? "SELECT pg_backend_pid()" : "SELECT CONNECTION_ID()";
  const result = toSqlResult(await reserved.unsafe(text).values());
  return Number(result.rows[0]?.[0]);
}

class BunSession implements SqlSession {
  private running = false;
  private pendingCancel: Promise<void> | null = null;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly sql: SQL,
    private readonly reserved: Reserved,
    private readonly backendId: number,
    private readonly database: string | null,
  ) {}

  async execute(text: string): Promise<SqlResult> {
    // A cancel signal still travelling could otherwise hit this statement.
    if (this.pendingCancel !== null) await this.pendingCancel.catch(() => undefined);
    const query = this.reserved.unsafe(text);
    this.running = true;
    try {
      return toSqlResult(await query.values());
    } finally {
      this.running = false;
    }
  }

  cancel(): Promise<void> {
    if (!this.running) return Promise.resolve();
    const settled = cancelFromSecondConnection(this.config, this.backendId, this.database);
    this.pendingCancel = settled;
    return settled;
  }

  async close(): Promise<void> {
    if (this.pendingCancel !== null) await this.pendingCancel.catch(() => undefined);
    this.reserved.release();
    await this.sql.close();
  }
}

/** One pinned connection per session, so `USE`, `SET` and transactions persist. */
/** Opens the session on `database`; a null Postgres database falls back to `postgres`. */
export const bunSessionFactory: SqlSessionFactory = async (config, requested) => {
  const database = requested ?? (config.engine === "postgres" ? "postgres" : null);
  const sql = new SQL(sqlOptions(config, database, 1));
  try {
    const reserved = (await sql.reserve()) as unknown as Reserved;
    const id = await backendId(config, reserved);
    return new BunSession(config, sql, reserved, id, database);
  } catch (error) {
    await sql.close();
    throw error;
  }
};
