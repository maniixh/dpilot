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

/** Small pools: the explorer runs a handful of catalog queries at a time. */
export const bunSqlFactory: SqlClientFactory = (config, database) => {
  const sql = new SQL({
    adapter: config.engine,
    hostname: config.host,
    port: config.port,
    username: config.username,
    password: config.password ?? "",
    ...(database === null ? {} : { database }),
    tls: tlsOption(config),
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
