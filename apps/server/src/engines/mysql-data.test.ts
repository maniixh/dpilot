import { describe, expect, test } from "bun:test";
import type { ConnectionConfig } from "../connections/types.ts";
import { defineDataAdapterContract, isNullable } from "../testing/data-contract.ts";
import { FakeSqlFactory } from "../testing/fake-sql.ts";
import { createMysqlDataAdapter } from "./mysql-data.ts";

const config: ConnectionConfig = {
  engine: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  password: "x",
  database: null,
  tls: { mode: "off", ca: null },
  readOnly: false,
};

const COLUMNS = [
  ["id", "bigint", "bigint", "NO", "", null],
  ["note", "text", "text", "YES", "", null],
  ["img", "blob", "blob", "YES", "", null],
] as const;

function column(
  [name, type, dataType, nullable, extra, defaultValue]: (typeof COLUMNS)[number],
  overrides: Record<string, unknown> = {},
) {
  return { name, type, dataType, nullable, extra, defaultValue, ...overrides };
}

defineDataAdapterContract("MySQL", () => {
  const sql = new FakeSqlFactory();
  return {
    sql,
    db: "app",
    ref: { schema: null, table: "grid" },
    catalog: /information_schema\.(TABLES|COLUMNS|STATISTICS)/,
    adapter: (readOnly) =>
      createMysqlDataAdapter({ ...config, readOnly }, sql.factory, { managed: false, readOnly }),
    script: (table) => {
      sql.respond(/information_schema\.TABLES/, [{ type: table.view ? "VIEW" : "BASE TABLE" }]);
      sql.respond(
        /information_schema\.COLUMNS/,
        COLUMNS.map((spec) =>
          column(spec, { nullable: isNullable(table, spec[0]) ? "YES" : "NO" }),
        ),
      );
      sql.respond(
        /information_schema\.STATISTICS/,
        table.keys.flatMap((names, index) =>
          names.map((name) => ({
            indexName: table.primary && index === 0 ? "PRIMARY" : `u${index}`,
            column: name,
          })),
        ),
      );
    },
  };
});

describe("MySQL data adapter specifics", () => {
  test("an update that changes no values still succeeds on a locked row", async () => {
    const sql = new FakeSqlFactory();
    sql.respond(/information_schema\.TABLES/, [{ type: "BASE TABLE" }]);
    sql.respond(
      /information_schema\.COLUMNS/,
      COLUMNS.map((spec) => column(spec, { nullable: spec[0] === "id" ? "NO" : "YES" })),
    );
    sql.respond(/information_schema\.STATISTICS/, [{ indexName: "PRIMARY", column: "id" }]);
    sql.respondExecute(/FOR UPDATE/, {
      columns: ["1"],
      rows: [[1]],
      command: null,
      affected: null,
    });
    sql.respondExecute(/^UPDATE/, { columns: [], rows: [], command: null, affected: 0 });
    const adapter = createMysqlDataAdapter(config, sql.factory, {
      managed: false,
      readOnly: false,
    });
    const result = await adapter.update("app", {
      ref: { schema: null, table: "grid" },
      key: { id: "1" },
      values: { note: { set: "same" } },
    });
    expect(result).toEqual({ affected: 1 });
    expect(sql.calls.at(-1)?.text).toBe("COMMIT");
  });

  test("qualifies the table with the database and maps column kinds", async () => {
    const sql = new FakeSqlFactory();
    const specs: [string, string, string, string][] = [
      ["a", "tinyint(1)", "tinyint", ""],
      ["b", "int(11)", "int", "auto_increment"],
      ["c", "decimal(10,2)", "decimal", ""],
      ["d", "double", "double", ""],
      ["e", "date", "date", ""],
      ["f", "datetime(6)", "datetime", ""],
      ["g", "time", "time", ""],
      ["h", "json", "json", ""],
      ["i", "varbinary(8)", "varbinary", ""],
      ["j", "enum('x')", "enum", ""],
      ["k", "int(11)", "int", "STORED GENERATED"],
      ["l", "geometry", "geometry", ""],
    ];
    sql.respond(/information_schema\.TABLES/, [{ type: "BASE TABLE" }]);
    sql.respond(
      /information_schema\.COLUMNS/,
      specs.map(([name, type, dataType, extra]) => ({
        name,
        type,
        dataType,
        nullable: "YES",
        extra,
        defaultValue: null,
      })),
    );
    sql.respond(/information_schema\.STATISTICS/, []);
    sql.respond(/LIMIT/, []);
    const adapter = createMysqlDataAdapter(config, sql.factory, {
      managed: false,
      readOnly: false,
    });
    const meta = await adapter.table("app", { schema: null, table: "grid" });
    expect(meta.columns.map((c) => c.kind)).toEqual([
      "boolean",
      "integer",
      "decimal",
      "float",
      "date",
      "datetime",
      "time",
      "json",
      "binary",
      "text",
      "integer",
      "other",
    ]);
    expect(meta.columns[1]?.autoIncrement).toBe(true);
    expect(meta.columns[10]?.generated).toBe(true);

    await adapter.rows("app", {
      ref: { schema: null, table: "grid" },
      filters: [],
      search: null,
      sort: [],
      offset: 0,
      limit: 1,
    });
    const page = sql.calls.find((call) => call.text.includes("LIMIT"));
    expect(page?.text).toContain("FROM `app`.`grid`");
  });
});
