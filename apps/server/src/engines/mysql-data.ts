import type { ColumnKind, ColumnMeta } from "@dpilot/shared";
import { z } from "zod";
import type { ConnectionConfig } from "../connections/types.ts";
import { buildDataAdapter, type CatalogTable, type CompletionRow } from "./data-adapter.ts";
import { parseRows, textish } from "./rows.ts";
import type { AdapterContext, DataAdapter, SqlClient, SqlClientFactory } from "./types.ts";

const TABLE_SQL =
  "SELECT TABLE_TYPE AS type FROM information_schema.TABLES " +
  "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?";
const COLUMNS_SQL =
  "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dataType, " +
  "IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra " +
  "FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? " +
  "ORDER BY ORDINAL_POSITION";
// Prefix indexes (SUB_PART) and nullable columns can't identify a row; PRIMARY sorts first.
const KEYS_SQL =
  "SELECT INDEX_NAME AS indexName, COLUMN_NAME AS `column` " +
  "FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? " +
  "AND NON_UNIQUE = 0 AND INDEX_NAME NOT IN (" +
  "SELECT INDEX_NAME FROM information_schema.STATISTICS " +
  "WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND (SUB_PART IS NOT NULL OR COLUMN_NAME IS NULL)) " +
  "ORDER BY INDEX_NAME <> 'PRIMARY', INDEX_NAME, SEQ_IN_INDEX";
const COMPLETION_SQL =
  "SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM information_schema.COLUMNS " +
  "WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION";

const tableRow = z.object({ type: textish });
const columnRow = z.object({
  name: textish,
  type: textish,
  dataType: textish,
  nullable: textish,
  defaultValue: textish.nullable(),
  extra: textish,
});
const keyRow = z.object({ indexName: textish, column: textish });
const completionRow = z.object({ tableName: textish, columnName: textish });

const KINDS: Record<string, ColumnKind> = {
  tinyint: "integer",
  smallint: "integer",
  mediumint: "integer",
  int: "integer",
  integer: "integer",
  bigint: "integer",
  year: "integer",
  decimal: "decimal",
  numeric: "decimal",
  float: "float",
  double: "float",
  date: "date",
  datetime: "datetime",
  timestamp: "datetime",
  time: "time",
  json: "json",
  tinyblob: "binary",
  blob: "binary",
  mediumblob: "binary",
  longblob: "binary",
  binary: "binary",
  varbinary: "binary",
  char: "text",
  varchar: "text",
  tinytext: "text",
  text: "text",
  mediumtext: "text",
  longtext: "text",
  enum: "text",
  set: "text",
};

function kindOf(type: string, dataType: string): ColumnKind {
  if (/^tinyint\(1\)/i.test(type)) return "boolean";
  return KINDS[dataType.toLowerCase()] ?? "other";
}

function toColumn(row: z.output<typeof columnRow>): ColumnMeta {
  const extra = row.extra.toLowerCase();
  return {
    name: row.name,
    type: row.type,
    kind: kindOf(row.type, row.dataType),
    nullable: row.nullable.toUpperCase() === "YES",
    defaultValue: row.defaultValue,
    generated: extra.includes("generated"),
    autoIncrement: extra.includes("auto_increment"),
  };
}

function groupKeys(rows: z.output<typeof keyRow>[]): string[][] {
  const keys = new Map<string, string[]>();
  for (const { indexName, column } of rows) {
    const names = keys.get(indexName) ?? [];
    names.push(column);
    keys.set(indexName, names);
  }
  return [...keys.values()];
}

/** MySQL and MariaDB: one session reaches every database, so tables are database-qualified. */
export function createMysqlDataAdapter(
  config: ConnectionConfig,
  factory: SqlClientFactory,
  ctx: AdapterContext,
): DataAdapter {
  let client: SqlClient | null = null;
  return buildDataAdapter(config, ctx, {
    dialect: "mysql",
    updateCountsChangesOnly: true,
    client: () => {
      client ??= factory(config, config.database);
      return client;
    },
    resolve: (db, ref) => ({ schema: db, table: ref.table }),
    describe: async (sql, db, ref): Promise<CatalogTable | null> => {
      const params = [db, ref.table];
      const [table] = parseRows(tableRow, await sql.query(TABLE_SQL, params));
      if (!table) return null;
      const columns = parseRows(columnRow, await sql.query(COLUMNS_SQL, params));
      const keys = parseRows(keyRow, await sql.query(KEYS_SQL, [...params, ...params]));
      return {
        kind: table.type.toUpperCase().includes("VIEW") ? "view" : "table",
        columns: columns.map(toColumn),
        uniqueKeys: groupKeys(keys),
      };
    },
    completion: async (sql, db): Promise<CompletionRow[]> =>
      parseRows(completionRow, await sql.query(COMPLETION_SQL, [db])),
    close: async () => {
      const open = client;
      client = null;
      await open?.close();
    },
  });
}
