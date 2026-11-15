import { SQL } from "bun";
import type { ConnectionConfig } from "../connections/types.ts";
import type { SqlClientFactory, SqlTransaction } from "./types.ts";

type TlsOption = "disable" | "require" | "verify-full" | { ca: string };

function tlsOption(config: ConnectionConfig): TlsOption {
  switch (config.tls.mode) {
    case "off":
      return "disable";
    case "require":
      return "require";
    case "verify":
      return config.tls.ca === null ? "verify-full" : { ca: config.tls.ca };
  }
}

/**
 * Bun's MySQL client selects the `mysql` database when given none, which non-root users
 * usually can't open; every user can open information_schema.
 */
function databaseOption(config: ConnectionConfig, database: string | null): string | null {
  if (database !== null) return database;
  return config.engine === "postgres" ? null : "information_schema";
}

/** Small pools: the explorer runs a handful of catalog queries at a time. */
export const bunSqlFactory: SqlClientFactory = (config, database) => {
  const selected = databaseOption(config, database);
  const sql = new SQL({
    adapter: config.engine,
    hostname: config.host,
    port: config.port,
    username: config.username,
    password: config.password ?? "",
    ...(selected === null ? {} : { database: selected }),
    tls: tlsOption(config),
    // Without TLS, MySQL 8's caching_sha2_password needs the server's RSA key to finish
    // authenticating any user whose password it hasn't cached yet.
    allowPublicKeyRetrieval: config.tls.mode === "off",
    max: 4,
    idleTimeout: 60,
    connectionTimeout: 10,
    bigint: true,
  });
  return {
    ...statements(sql),
    async transaction(fn) {
      return sql.begin(async (tx) => fn(statements(tx)));
    },
    async close() {
      await sql.close();
    },
  };
};

interface Runner {
  unsafe(text: string, params?: unknown[]): unknown;
}

interface ValuesResult {
  columns?: readonly { name: string }[];
  command?: string | null;
  affectedRows?: number | null;
}

function statements(runner: Runner): SqlTransaction {
  return {
    async query(text, params = []) {
      const rows: unknown = await runner.unsafe(text, [...params]);
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
    async execute(text, params = []) {
      const query = runner.unsafe(text, [...params]) as { values(): Promise<unknown> };
      const result = await query.values();
      const meta: ValuesResult = (
        typeof result === "object" && result !== null ? result : {}
      ) as ValuesResult;
      return {
        columns: (meta.columns ?? []).map((column) => column.name),
        rows: Array.isArray(result) ? (result as unknown[][]) : [],
        command: meta.command ?? null,
        affected: typeof meta.affectedRows === "number" ? meta.affectedRows : null,
      };
    },
  };
}
