import type { DatabaseEntry, ObjectGroups } from "@dpilot/shared";
import { z } from "zod";
import type { ConnectionConfig } from "../connections/types.ts";
import { classifyError, isPermissionDenied } from "./errors.ts";
import { guarded, numberish, parseRows, textish } from "./rows.ts";
import type { AdapterContext, ExplorerAdapter, SqlClient, SqlClientFactory } from "./types.ts";

const INFO_SQL = `SELECT current_setting('server_version') AS version, current_user AS "user",
  EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint AS uptime,
  current_setting('server_encoding') AS charset, current_setting('TimeZone') AS "timeZone"`;
const VARIABLES_SQL =
  "SELECT name, setting, unit, short_desc AS description FROM pg_settings ORDER BY name";
const DATABASES_SQL = `SELECT datname AS name,
  (datallowconn AND has_database_privilege(datname, 'CONNECT')) AS browsable
  FROM pg_database ORDER BY datname`;
const SCHEMAS_SQL = `SELECT nspname AS name FROM pg_namespace
  WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND left(nspname, 8) <> 'pg_temp_' AND left(nspname, 14) <> 'pg_toast_temp_'
  ORDER BY nspname`;
const RELATIONS_SQL = `SELECT c.relname AS name, c.relkind::text AS kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY c.relname`;
const ROUTINES_SQL = `SELECT DISTINCT p.proname AS name, p.prokind::text AS kind
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') ORDER BY p.proname`;

const infoRow = z.object({
  version: textish,
  user: textish,
  uptime: numberish.nullable(),
  charset: textish.nullable(),
  timeZone: textish.nullable(),
});
const variableRow = z.object({
  name: textish,
  setting: textish.nullable(),
  unit: textish.nullable(),
  description: textish.nullable(),
});
const databaseRow = z.object({ name: textish, browsable: z.boolean() });
const schemaRow = z.object({ name: textish });
const objectRow = z.object({ name: textish, kind: textish });

/** Postgres sessions are bound to one database, so the adapter keeps one client per database. */
export function createPostgresAdapter(
  config: ConnectionConfig,
  factory: SqlClientFactory,
  ctx: AdapterContext,
): ExplorerAdapter {
  const defaultDb = config.database ?? "postgres";
  const clients = new Map<string, SqlClient>();
  const sql = (db: string = defaultDb) => {
    let client = clients.get(db);
    if (!client) {
      client = factory(config, db);
      clients.set(db, client);
    }
    return client;
  };
  const run = <T>(fn: () => Promise<T>) => guarded(config, ctx, fn);
  const isSystem = (name: string) =>
    name === "template0" ||
    name === "template1" ||
    (name === "postgres" && config.database !== name);

  return {
    info: () =>
      run(async () => {
        const [info] = parseRows(infoRow, await sql().query(INFO_SQL));
        if (!info) throw new Error("The server returned no version information");
        return {
          engine: config.engine,
          version: info.version,
          user: info.user,
          uptimeSeconds: info.uptime,
          charset: info.charset,
          timeZone: info.timeZone,
        };
      }),

    variables: () =>
      run(async () =>
        parseRows(variableRow, await sql().query(VARIABLES_SQL)).map((row) => ({
          name: row.name,
          value: row.unit ? `${row.setting ?? ""} ${row.unit}` : (row.setting ?? ""),
          description: row.description,
        })),
      ),

    databases: async (): Promise<DatabaseEntry[]> => {
      try {
        return parseRows(databaseRow, await sql().query(DATABASES_SQL)).map((row) => ({
          name: row.name,
          system: isSystem(row.name),
          browsable: row.browsable,
        }));
      } catch (error) {
        if (isPermissionDenied(error) && config.database !== null) {
          return [{ name: config.database, system: false, browsable: true }];
        }
        throw classifyError(error, config, ctx);
      }
    },

    schemas: (db) => run(async () => parseRows(schemaRow, await sql(db).query(SCHEMAS_SQL))),

    objects: (db, schema) =>
      run(async (): Promise<ObjectGroups> => {
        const params = [schema ?? "public"];
        const relations = parseRows(objectRow, await sql(db).query(RELATIONS_SQL, params));
        const routines = parseRows(objectRow, await sql(db).query(ROUTINES_SQL, params));
        const names = (rows: typeof relations, kinds: string[]) =>
          rows.filter((row) => kinds.includes(row.kind)).map((row) => row.name);
        return {
          tables: names(relations, ["r", "p"]),
          views: names(relations, ["v", "m"]),
          procedures: names(routines, ["p"]),
          functions: names(routines, ["f"]),
        };
      }),

    close: async () => {
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(open.map((client) => client.close()));
    },
  };
}
