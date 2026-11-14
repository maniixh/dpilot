import type { DatabaseEntry, ObjectGroups } from "@dpilot/shared";
import { z } from "zod";
import type { ConnectionConfig } from "../connections/types.ts";
import { classifyError, isPermissionDenied } from "./errors.ts";
import { guarded, numberish, parseRows, textish } from "./rows.ts";
import type { AdapterContext, ExplorerAdapter, SqlClient, SqlClientFactory } from "./types.ts";

const SYSTEM_DATABASES = new Set(["information_schema", "mysql", "performance_schema", "sys"]);

const infoRow = z.object({
  version: textish,
  user: textish,
  charset: textish.nullable(),
  timeZone: textish.nullable(),
});
const statusRow = z.object({ Value: numberish });
const variableRow = z.object({ Variable_name: textish, Value: textish.nullable() });
const databaseRow = z.object({ Database: textish });
const objectRow = z.object({ name: textish, type: textish });

/** MySQL and MariaDB share one adapter; databases are reached through one session. */
export function createMysqlAdapter(
  config: ConnectionConfig,
  factory: SqlClientFactory,
  ctx: AdapterContext,
): ExplorerAdapter {
  let client: SqlClient | null = null;
  const sql = () => {
    client ??= factory(config, config.database);
    return client;
  };
  const run = <T>(fn: () => Promise<T>) => guarded(config, ctx, fn);

  return {
    info: () =>
      run(async () => {
        const [info] = parseRows(
          infoRow,
          await sql().query(
            "SELECT VERSION() AS version, CURRENT_USER() AS user, " +
              "@@character_set_server AS charset, @@time_zone AS timeZone",
          ),
        );
        const uptime = await sql().query("SHOW GLOBAL STATUS LIKE 'Uptime'");
        const [status] = parseRows(statusRow, uptime);
        if (!info) throw new Error("The server returned no version information");
        return {
          engine: config.engine,
          version: info.version,
          user: info.user,
          uptimeSeconds: status?.Value ?? null,
          charset: info.charset,
          timeZone: info.timeZone,
        };
      }),

    variables: () =>
      run(async () =>
        parseRows(variableRow, await sql().query("SHOW GLOBAL VARIABLES")).map((row) => ({
          name: row.Variable_name,
          value: row.Value ?? "",
          description: null,
        })),
      ),

    databases: async (): Promise<DatabaseEntry[]> => {
      try {
        const rows = parseRows(databaseRow, await sql().query("SHOW DATABASES"));
        return rows.map(({ Database: name }) => ({
          name,
          system: SYSTEM_DATABASES.has(name.toLowerCase()),
          browsable: true,
        }));
      } catch (error) {
        if (isPermissionDenied(error) && config.database !== null) {
          return [{ name: config.database, system: false, browsable: true }];
        }
        throw classifyError(error, config, ctx);
      }
    },

    schemas: async () => [],

    objects: (db) =>
      run(async (): Promise<ObjectGroups> => {
        const tables = parseRows(
          objectRow,
          await sql().query(
            "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES " +
              "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            [db],
          ),
        );
        const routines = parseRows(
          objectRow,
          await sql().query(
            "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES " +
              "WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME",
            [db],
          ),
        );
        const names = (rows: typeof tables, types: string[]) =>
          rows.filter((row) => types.includes(row.type)).map((row) => row.name);
        return {
          tables: names(tables, ["BASE TABLE"]),
          views: names(tables, ["VIEW", "SYSTEM VIEW"]),
          procedures: names(routines, ["PROCEDURE"]),
          functions: names(routines, ["FUNCTION"]),
        };
      }),

    close: async () => {
      const open = client;
      client = null;
      await open?.close();
    },
  };
}
