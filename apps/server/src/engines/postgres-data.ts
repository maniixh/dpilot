import type { ColumnKind, ColumnMeta } from "@dpilot/shared";
import { z } from "zod";
import type { ConnectionConfig } from "../connections/types.ts";
import { buildDataAdapter, type CatalogTable, type CompletionRow } from "./data-adapter.ts";
import { parseRows, textish } from "./rows.ts";
import type { AdapterContext, DataAdapter, SqlClient, SqlClientFactory } from "./types.ts";

const RELATION_SQL = `SELECT c.relkind::text AS kind
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`;
const COLUMNS_SQL = `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
  t.typname::text AS typname, t.typcategory::text AS category, NOT a.attnotnull AS nullable,
  pg_get_expr(d.adbin, d.adrelid) AS "defaultValue",
  a.attgenerated::text AS generated, a.attidentity::text AS identity
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t ON t.oid = a.atttypid
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attnum`;
// Partial and expression indexes can't identify a row; the primary key sorts first.
const KEYS_SQL = `SELECT i.indexrelid::bigint AS "indexId", a.attname AS "column"
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE n.nspname = $1 AND c.relname = $2 AND i.indisunique AND i.indisvalid
    AND i.indpred IS NULL AND i.indexprs IS NULL
  ORDER BY i.indisprimary DESC, i.indexrelid, k.ord`;
const COMPLETION_SQL = `SELECT table_name AS "tableName", column_name AS "columnName"
  FROM information_schema.columns WHERE table_schema = $1
  ORDER BY table_name, ordinal_position`;

const relationRow = z.object({ kind: textish });
const columnRow = z.object({
  name: textish,
  type: textish,
  typname: textish,
  category: textish,
  nullable: z.boolean(),
  defaultValue: textish.nullable(),
  generated: textish,
  identity: textish,
});
const keyRow = z.object({ indexId: textish, column: textish });
const completionRow = z.object({ tableName: textish, columnName: textish });

const INTEGER_TYPES = new Set(["int2", "int4", "int8", "oid"]);
const FLOAT_TYPES = new Set(["float4", "float8"]);

function numericKind(typname: string): ColumnKind {
  if (INTEGER_TYPES.has(typname)) return "integer";
  if (FLOAT_TYPES.has(typname)) return "float";
  return typname === "numeric" ? "decimal" : "other";
}

function dateKind(typname: string): ColumnKind {
  if (typname === "date") return "date";
  return typname.startsWith("time") && typname !== "timestamp" && typname !== "timestamptz"
    ? "time"
    : "datetime";
}

function kindOf({ category, typname }: Pick<z.output<typeof columnRow>, "category" | "typname">) {
  if (typname === "json" || typname === "jsonb") return "json";
  if (typname === "bytea") return "binary";
  switch (category) {
    case "N":
      return numericKind(typname);
    case "B":
      return "boolean";
    case "D":
      return dateKind(typname);
    case "S":
      return "text";
    default:
      return "other";
  }
}

function toColumn(row: z.output<typeof columnRow>): ColumnMeta {
  return {
    name: row.name,
    type: row.type,
    kind: kindOf(row),
    nullable: row.nullable,
    defaultValue: row.defaultValue,
    generated: row.generated !== "" || row.identity === "a",
    autoIncrement: row.identity !== "" || (row.defaultValue ?? "").startsWith("nextval("),
  };
}

function groupKeys(rows: z.output<typeof keyRow>[]): string[][] {
  const keys = new Map<string, string[]>();
  for (const { indexId, column } of rows) {
    const names = keys.get(indexId) ?? [];
    names.push(column);
    keys.set(indexId, names);
  }
  return [...keys.values()];
}

/** Postgres sessions are bound to one database, so the adapter keeps one client per database. */
export function createPostgresDataAdapter(
  config: ConnectionConfig,
  factory: SqlClientFactory,
  ctx: AdapterContext,
): DataAdapter {
  const clients = new Map<string, SqlClient>();
  return buildDataAdapter(config, ctx, {
    dialect: "postgres",
    updateCountsChangesOnly: false,
    client: (db) => {
      let client = clients.get(db);
      if (!client) {
        client = factory(config, db);
        clients.set(db, client);
      }
      return client;
    },
    resolve: (_db, ref) => ({ schema: ref.schema ?? "public", table: ref.table }),
    describe: async (sql, _db, ref): Promise<CatalogTable | null> => {
      const params = [ref.schema, ref.table];
      const [relation] = parseRows(relationRow, await sql.query(RELATION_SQL, params));
      if (!relation) return null;
      const columns = parseRows(columnRow, await sql.query(COLUMNS_SQL, params));
      const keys = parseRows(keyRow, await sql.query(KEYS_SQL, params));
      return {
        kind: relation.kind === "v" || relation.kind === "m" ? "view" : "table",
        columns: columns.map(toColumn),
        uniqueKeys: groupKeys(keys),
      };
    },
    completion: async (sql, _db, schema): Promise<CompletionRow[]> =>
      parseRows(completionRow, await sql.query(COMPLETION_SQL, [schema ?? "public"])),
    close: async () => {
      const open = [...clients.values()];
      clients.clear();
      await Promise.all(open.map((client) => client.close()));
    },
  });
}
