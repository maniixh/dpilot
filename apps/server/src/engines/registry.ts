import type { ConnectionConfig } from "../connections/types.ts";
import { createMysqlAdapter } from "./mysql.ts";
import { createPostgresAdapter } from "./postgres.ts";
import type { AdapterContext, ExplorerAdapter, SqlClientFactory } from "./types.ts";

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
