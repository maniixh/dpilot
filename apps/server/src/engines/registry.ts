import type { ConnectionConfig } from "../connections/types.ts";
import { createMysqlAdapter } from "./mysql.ts";
import { createMysqlDataAdapter } from "./mysql-data.ts";
import { createPostgresAdapter } from "./postgres.ts";
import { createPostgresDataAdapter } from "./postgres-data.ts";
import type { AdapterContext, DataAdapter, ExplorerAdapter, SqlClientFactory } from "./types.ts";

export function createAdapter(
  config: ConnectionConfig,
  factory: SqlClientFactory,
  ctx: AdapterContext,
): ExplorerAdapter {
  switch (config.engine) {
    case "mysql":
    case "mariadb":
      return createMysqlAdapter(config, factory, ctx);
    case "postgres":
      return createPostgresAdapter(config, factory, ctx);
  }
}

export function createDataAdapter(
  config: ConnectionConfig,
  factory: SqlClientFactory,
  ctx: AdapterContext,
): DataAdapter {
  switch (config.engine) {
    case "mysql":
    case "mariadb":
      return createMysqlDataAdapter(config, factory, ctx);
    case "postgres":
      return createPostgresDataAdapter(config, factory, ctx);
  }
}
