import { describe, expect, test } from "bun:test";
import type { ConnectionConfig } from "../connections/types.ts";
import { defineDataAdapterContract, isNullable } from "../testing/data-contract.ts";
import { FakeSqlFactory } from "../testing/fake-sql.ts";
import { createPostgresDataAdapter } from "./postgres-data.ts";

const config: ConnectionConfig = {
  engine: "postgres",
  host: "127.0.0.1",
  port: 5432,
  username: "postgres",
  password: "x",
  database: "app",
  tls: { mode: "off", ca: null },
  readOnly: false,
};

interface ColumnSpec {
  name: string;
  type: string;
  typname: string;
  category: string;
  generated?: string;
  identity?: string;
  defaultValue?: string | null;
}

function columnRows(specs: ColumnSpec[], nullable: (name: string) => boolean) {
  return specs.map((spec) => ({
    generated: "",
    identity: "",
    defaultValue: null,
    ...spec,
    nullable: nullable(spec.name),
  }));
}

const BASE: ColumnSpec[] = [
  { name: "id", type: "bigint", typname: "int8", category: "N" },
  { name: "note", type: "text", typname: "text", category: "S" },
  { name: "img", type: "bytea", typname: "bytea", category: "U" },
];

defineDataAdapterContract("Postgres", () => {
  const sql = new FakeSqlFactory();
  return {
    sql,
    db: "app",
    ref: { schema: "public", table: "grid" },
    catalog: /relkind|format_type|indisunique/,
    adapter: (readOnly) =>
      createPostgresDataAdapter({ ...config, readOnly }, sql.factory, {
        managed: false,
        readOnly,
      }),
    script: (table) => {
      sql.respond(/relkind/, [{ kind: table.view ? "v" : "r" }]);
      sql.respond(
        /format_type/,
        columnRows(BASE, (name) => isNullable(table, name)),
      );
      sql.respond(
        /indisunique/,
        table.keys.flatMap((names, index) =>
          names.map((name) => ({ indexId: index + 1, column: name })),
        ),
      );
    },
  };
});

describe("Postgres data adapter specifics", () => {
  test("maps catalog types to kinds and defaults the schema to public", async () => {
    const sql = new FakeSqlFactory();
    const specs: ColumnSpec[] = [
      { name: "a", type: "smallint", typname: "int2", category: "N" },
      { name: "b", type: "numeric(10,2)", typname: "numeric", category: "N" },
      { name: "c", type: "double precision", typname: "float8", category: "N" },
      { name: "d", type: "boolean", typname: "bool", category: "B" },
      { name: "e", type: "date", typname: "date", category: "D" },
      { name: "f", type: "timestamp(6) without time zone", typname: "timestamp", category: "D" },
      { name: "g", type: "time without time zone", typname: "time", category: "D" },
      { name: "h", type: "jsonb", typname: "jsonb", category: "U" },
      { name: "i", type: "character varying(5)", typname: "varchar", category: "S" },
      { name: "j", type: "integer[]", typname: "_int4", category: "A" },
      {
        name: "k",
        type: "integer",
        typname: "int4",
        category: "N",
        identity: "d",
        defaultValue: null,
      },
      {
        name: "l",
        type: "integer",
        typname: "int4",
        category: "N",
        defaultValue: "nextval('t_l_seq'::regclass)",
      },
      { name: "m", type: "integer", typname: "int4", category: "N", generated: "s" },
      { name: "n", type: "interval", typname: "interval", category: "T" },
    ];
    sql.respond(/relkind/, [{ kind: "r" }]);
    sql.respond(
      /format_type/,
      columnRows(specs, () => true),
    );
    sql.respond(/indisunique/, []);
    const adapter = createPostgresDataAdapter(config, sql.factory, {
      managed: false,
      readOnly: false,
    });
    const meta = await adapter.table("app", { schema: null, table: "grid" });
    expect(meta.columns.map((c) => c.kind)).toEqual([
      "integer",
      "decimal",
      "float",
      "boolean",
      "date",
      "datetime",
      "time",
      "json",
      "text",
      "other",
      "integer",
      "integer",
      "integer",
      "other",
    ]);
    expect(meta.columns.map((c) => c.autoIncrement)).toEqual([
      ...Array<boolean>(10).fill(false),
      true,
      true,
      false,
      false,
    ]);
    expect(meta.columns.map((c) => c.generated).slice(10)).toEqual([false, false, true, false]);
    const catalogCall = sql.calls.find((call) => /relkind/.test(call.text));
    expect(catalogCall?.params).toEqual(["public", "grid"]);
  });

  test("keeps one client per database", async () => {
    const sql = new FakeSqlFactory();
    sql.respond(/relkind/, []);
    const adapter = createPostgresDataAdapter(config, sql.factory, {
      managed: false,
      readOnly: false,
    });
    const ref = { schema: "public", table: "t" };
    await adapter.table("one", ref).catch(() => {});
    await adapter.table("two", ref).catch(() => {});
    await adapter.table("one", ref).catch(() => {});
    expect(sql.created).toEqual(["one", "two"]);
    await adapter.close();
    expect(sql.closed.sort()).toEqual(["one", "two"]);
  });
});
