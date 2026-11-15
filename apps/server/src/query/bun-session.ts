import { SQL } from "bun";
import type { ConnectionConfig } from "../connections/types.ts";
import { sqlOptions, toSqlResult } from "../engines/bun-sql.ts";
import type { SqlResult } from "../engines/types.ts";
import type { SqlSession, SqlSessionFactory } from "./types.ts";

interface PendingQuery {
  values(): Promise<unknown>;
  cancel(): void;
}

interface Reserved {
  unsafe(text: string): PendingQuery;
  release(): void;
}

/** MySQL ignores `query.cancel()`, so the statement is killed from a second connection. */
async function killMysqlQuery(config: ConnectionConfig, connectionId: number): Promise<void> {
  if (!Number.isSafeInteger(connectionId)) throw new Error("Invalid connection id.");
  const killer = new SQL(sqlOptions(config, null, 1));
  try {
    // KILL takes no bound parameter; the text is built from a verified integer.
    await killer.unsafe(`KILL QUERY ${connectionId}`);
  } finally {
    await killer.close();
  }
}

async function mysqlConnectionId(reserved: Reserved): Promise<number> {
  const result = toSqlResult(await reserved.unsafe("SELECT CONNECTION_ID()").values());
  return Number(result.rows[0]?.[0]);
}

class BunSession implements SqlSession {
  private inFlight: PendingQuery | null = null;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly sql: SQL,
    private readonly reserved: Reserved,
    private readonly connectionId: number | null,
  ) {}

  async execute(text: string): Promise<SqlResult> {
    const query = this.reserved.unsafe(text);
    this.inFlight = query;
    try {
      return toSqlResult(await query.values());
    } finally {
      this.inFlight = null;
    }
  }

  async cancel(): Promise<void> {
    const query = this.inFlight;
    if (query === null) return;
    if (this.connectionId === null) {
      query.cancel();
      return;
    }
    await killMysqlQuery(this.config, this.connectionId);
  }

  async close(): Promise<void> {
    this.reserved.release();
    await this.sql.close();
  }
}

/** One pinned connection per session, so `USE`, `SET` and transactions persist. */
export const bunSessionFactory: SqlSessionFactory = async (config, database) => {
  const sql = new SQL(sqlOptions(config, database, 1));
  try {
    const reserved = (await sql.reserve()) as unknown as Reserved;
    const connectionId = config.engine === "postgres" ? null : await mysqlConnectionId(reserved);
    return new BunSession(config, sql, reserved, connectionId);
  } catch (error) {
    await sql.close();
    throw error;
  }
};
