import type { ConnectionConfig } from "../connections/types.ts";
import type { SqlClient, SqlClientFactory, SqlResult } from "../engines/types.ts";

interface Response {
  pattern: RegExp;
  result: Record<string, unknown>[] | Error;
}

interface ExecuteResponse {
  pattern: RegExp;
  result: SqlResult | Error;
}

const EMPTY_RESULT: SqlResult = { columns: [], rows: [], command: null, affected: null };

/** Scripted SqlClientFactory: the most recently added matching response wins. */
export class FakeSqlFactory {
  readonly calls: { database: string | null; text: string; params: readonly unknown[] }[] = [];
  readonly created: (string | null)[] = [];
  readonly closed: (string | null)[] = [];
  readonly configs: ConnectionConfig[] = [];
  private responses: Response[] = [];
  private executeResponses: ExecuteResponse[] = [];

  respond(pattern: RegExp, result: Record<string, unknown>[] | Error): void {
    this.responses.unshift({ pattern, result });
  }

  /** Scripts `execute` (and statements run inside `transaction`). */
  respondExecute(pattern: RegExp, result: SqlResult | Error): void {
    this.executeResponses.unshift({ pattern, result });
  }

  readonly factory: SqlClientFactory = (config, database) => {
    this.created.push(database);
    this.configs.push(config);
    const record = (text: string, params: readonly unknown[] = []) => {
      this.calls.push({ database, text, params });
    };
    const client: SqlClient = {
      query: async (text, params = []) => {
        record(text, params);
        const match = this.responses.find((r) => r.pattern.test(text));
        if (!match) return [];
        if (match.result instanceof Error) throw match.result;
        return match.result;
      },
      execute: async (text, params = []) => {
        record(text, params);
        const match = this.executeResponses.find((r) => r.pattern.test(text));
        if (!match) return EMPTY_RESULT;
        if (match.result instanceof Error) throw match.result;
        return match.result;
      },
      transaction: async (fn) => {
        record("BEGIN");
        try {
          const result = await fn(client);
          record("COMMIT");
          return result;
        } catch (error) {
          record("ROLLBACK");
          throw error;
        }
      },
      close: async () => {
        this.closed.push(database);
      },
    };
    return client;
  };
}

/** An error shaped like the ones Bun.SQL throws. */
export function driverError(fields: Record<string, unknown>, message = "driver error"): Error {
  return Object.assign(new Error(message), fields);
}
