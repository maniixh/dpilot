import type { ConnectionConfig } from "../connections/types.ts";
import type { SqlClient, SqlClientFactory } from "../engines/types.ts";

interface Response {
  pattern: RegExp;
  result: Record<string, unknown>[] | Error;
}

/** Scripted SqlClientFactory: the most recently added matching response wins. */
export class FakeSqlFactory {
  readonly calls: { database: string | null; text: string; params: readonly unknown[] }[] = [];
  readonly created: (string | null)[] = [];
  readonly closed: (string | null)[] = [];
  readonly configs: ConnectionConfig[] = [];
  private responses: Response[] = [];

  respond(pattern: RegExp, result: Record<string, unknown>[] | Error): void {
    this.responses.unshift({ pattern, result });
  }

  readonly factory: SqlClientFactory = (config, database) => {
    this.created.push(database);
    this.configs.push(config);
    const client: SqlClient = {
      query: async (text, params = []) => {
        this.calls.push({ database, text, params });
        const match = this.responses.find((r) => r.pattern.test(text));
        if (!match) return [];
        if (match.result instanceof Error) throw match.result;
        return match.result;
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
