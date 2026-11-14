import { SQL } from "bun";
import type { ConnectionConfig } from "../connections/types.ts";
import type { SqlClientFactory } from "./types.ts";

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
    max: 2,
    idleTimeout: 60,
    connectionTimeout: 10,
  });
  return {
    async query(text, params = []) {
      const rows: unknown = await sql.unsafe(text, [...params]);
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    },
    async close() {
      await sql.close();
    },
  };
};
