import { describe, expect, test } from "bun:test";
import type { ColumnKind, ColumnMeta, RowsQuery, TableMeta, TableRef } from "@dpilot/shared";
import {
  aggregate,
  countRows,
  deleteRow,
  insertRow,
  lockRow,
  postgresCastType,
  qualified,
  quoteIdent,
  selectCell,
  selectPage,
  updateCell,
  updateRow,
} from "./dialect.ts";
import { DataError } from "./types.ts";

function column(name: string, kind: ColumnKind, type: string): ColumnMeta {
  return {
    name,
    type,
    kind,
    nullable: true,
    defaultValue: null,
    generated: false,
    autoIncrement: false,
  };
}

const meta: TableMeta = {
  kind: "table",
  columns: [
    column("id", "integer", "bigint"),
    column("at", "datetime", "timestamp(6) without time zone"),
    column("note", "text", "text"),
    column("tags", "other", "integer[]"),
    column("img", "binary", "bytea"),
    column("price", "decimal", "numeric(10,2)"),
  ],
  primaryKey: ["id"],
  editable: true,
  readOnlyReason: null,
};
const ref: TableRef = { schema: "public", table: "grid" };
const mysqlRef: TableRef = { schema: null, table: "grid" };

function query(overrides: Partial<RowsQuery> = {}): RowsQuery {
  return { ref, filters: [], search: null, sort: [], offset: 0, limit: 100, ...overrides };
}

function invalid(run: () => unknown): DataError {
  try {
    run();
  } catch (error) {
    if (error instanceof DataError) return error;
    throw error;
  }
  throw new Error("expected DataError");
}

describe("quoteIdent", () => {
  test("quotes identifiers containing the quote character", () => {
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
  });

  test("keeps semicolons, dots and spaces inside the quotes", () => {
    expect(quoteIdent("mysql", "x`; DROP TABLE t; --")).toBe("`x``; DROP TABLE t; --`");
    expect(quoteIdent("postgres", 'x"; DROP TABLE t; --')).toBe('"x""; DROP TABLE t; --"');
    expect(quoteIdent("postgres", "a.b c")).toBe('"a.b c"');
  });

  test("qualifies with the schema only when present", () => {
    expect(qualified("postgres", ref)).toBe('"public"."grid"');
    expect(qualified("mysql", mysqlRef)).toBe("`grid`");
  });
});

describe("selectPage", () => {
  test("drops length modifiers from Postgres casts so values are not truncated", () => {
    const sized: TableMeta = {
      ...meta,
      columns: [
        column("id", "integer", "bigint"),
        column("code", "text", "character varying(5)"),
        column("price", "decimal", "numeric(10,2)"),
        column("at", "datetime", "timestamp(3) with time zone"),
        column("tags", "other", "character varying(5)[]"),
      ],
    };
    const update = updateRow(
      "postgres",
      sized,
      ref,
      { id: "1" },
      {
        code: { set: "toolong" },
        price: { set: "1.239" },
        at: { set: "2024-01-01" },
      },
    );
    expect(update.text).toBe(
      'UPDATE "public"."grid" SET "code" = $1::character varying, "price" = $2::numeric, ' +
        '"at" = $3::timestamp with time zone WHERE "id" = $4::bigint',
    );
    const select = selectPage(
      "postgres",
      sized,
      ref,
      query({ filters: [{ op: "in", column: "code", values: ["a", "b"] }] }),
    );
    expect(select.text).toContain('"code" IN ($1::character varying, $2::character varying)');
    expect(postgresCastType("character varying(5)[]")).toBe("character varying[]");
    expect(postgresCastType("bit(3)")).toBe("bit");
    expect(postgresCastType("bigint")).toBe("bigint");
  });

  test("casts MySQL integer and decimal filter values exactly", () => {
    const built = selectPage(
      "mysql",
      meta,
      mysqlRef,
      query({
        ref: mysqlRef,
        filters: [
          { op: "eq", column: "id", value: "9007199254740993" },
          { op: "in", column: "id", values: ["1", "2"] },
          { op: "ge", column: "price", value: "1.5" },
          { op: "eq", column: "note", value: "x" },
        ],
      }),
    );
    expect(built.text).toContain("`id` = CAST(? AS SIGNED)");
    expect(built.text).toContain("`id` IN (CAST(? AS SIGNED), CAST(? AS SIGNED))");
    expect(built.text).toContain("`price` >= CAST(? AS DECIMAL(65,30))");
    expect(built.text).toContain("`note` = ?");
  });

  test("compares Postgres json and other kinds as text for equality filters", () => {
    const jsonMeta: TableMeta = {
      ...meta,
      columns: [column("doc", "json", "json"), column("loc", "other", "point")],
      primaryKey: [],
      editable: false,
    };
    const built = selectPage(
      "postgres",
      jsonMeta,
      ref,
      query({
        filters: [
          { op: "eq", column: "doc", value: '{"a":1}' },
          { op: "not_in", column: "loc", values: ["(1,2)"] },
        ],
      }),
    );
    expect(built.text).toContain('"doc"::text = $1');
    expect(built.text).toContain('"loc"::text NOT IN ($2)');
    expect(built.text).not.toContain("::json");
  });

  test("casts dates and json to text and selects key aliases", () => {
    const built = selectPage("postgres", meta, ref, query());
    expect(built.text).toContain('"at"::text AS "at"');
    expect(built.text).toContain('"tags"::text AS "tags"');
    expect(built.text).toContain('"price"::text AS "price"');
    expect(built.text).toContain('"id"::text AS "__k0"');
    expect(built.text).toContain('"note"');
    expect(built.text).not.toContain('"note"::text');
    expect(built.text).not.toContain('"img"::text');

    const mysql = selectPage("mysql", meta, mysqlRef, query({ ref: mysqlRef }));
    expect(mysql.text).toContain("CAST(`at` AS CHAR) AS `at`");
    expect(mysql.text).toContain("CAST(`id` AS CHAR) AS `__k0`");
  });

  test("orders by the primary key when no sort is given", () => {
    expect(selectPage("postgres", meta, ref, query()).text).toContain('ORDER BY "id"');
    const sorted = selectPage(
      "postgres",
      meta,
      ref,
      query({ sort: [{ column: "note", direction: "desc" }] }),
    );
    expect(sorted.text).toContain('ORDER BY "note" DESC');
  });

  test("binds filter values and paging as parameters", () => {
    const secret = "x'; DROP TABLE grid; --";
    const built = selectPage(
      "mysql",
      meta,
      mysqlRef,
      query({
        ref: mysqlRef,
        filters: [
          { op: "eq", column: "note", value: secret },
          { op: "in", column: "id", values: ["1", "2"] },
          { op: "is_null", column: "at" },
        ],
        limit: 50,
        offset: 10,
      }),
    );
    expect(built.text).not.toContain("DROP");
    expect(built.text).toContain("`note` = ?");
    expect(built.text).toContain("`id` IN (CAST(? AS SIGNED), CAST(? AS SIGNED))");
    expect(built.text).toContain("`at` IS NULL");
    expect(built.params).toEqual([secret, "1", "2", 50, 10]);
    expect(built.text.endsWith("LIMIT ? OFFSET ?")).toBe(true);
  });

  test("casts Postgres parameters to the column type", () => {
    const built = selectPage(
      "postgres",
      meta,
      ref,
      query({ filters: [{ op: "ge", column: "id", value: "7" }] }),
    );
    expect(built.text).toContain('"id" >= $1::bigint');
    expect(built.text).toContain("LIMIT $2 OFFSET $3");
    expect(built.params).toEqual(["7", 100, 0]);
  });

  test("compares like filters as text", () => {
    const built = selectPage(
      "postgres",
      meta,
      ref,
      query({ filters: [{ op: "like", column: "at", value: "2024%" }] }),
    );
    expect(built.text).toContain('"at"::text LIKE $1');
  });

  test("search uses ILIKE on Postgres and escapes % _ and backslash", () => {
    const pg = selectPage("postgres", meta, ref, query({ search: "50%_\\" }));
    expect(pg.text).toContain(`"note" ILIKE $1 ESCAPE '\\'`);
    expect(pg.params[0]).toBe("%50\\%\\_\\\\%");

    const my = selectPage("mysql", meta, mysqlRef, query({ ref: mysqlRef, search: "a" }));
    expect(my.text).toContain("`note` LIKE ? ESCAPE '\\\\'");
  });

  test("matches nothing when searching a table without text columns", () => {
    const numeric: TableMeta = { ...meta, columns: [column("id", "integer", "bigint")] };
    expect(selectPage("postgres", numeric, ref, query({ search: "a" })).text).toContain("1 = 0");
  });

  test("rejects an unknown column", () => {
    const error = invalid(() =>
      selectPage("postgres", meta, ref, query({ filters: [{ op: "is_null", column: "nope" }] })),
    );
    expect(error.code).toBe("invalid_request");
    expect(
      invalid(() =>
        selectPage("mysql", meta, mysqlRef, query({ sort: [{ column: "x`", direction: "asc" }] })),
      ).code,
    ).toBe("invalid_request");
  });

  test("rejects like on a binary column", () => {
    const error = invalid(() =>
      selectPage(
        "postgres",
        meta,
        ref,
        query({ filters: [{ op: "like", column: "img", value: "a" }] }),
      ),
    );
    expect(error.code).toBe("invalid_request");
  });

  test("quotes awkward table and column names", () => {
    const awkward: TableMeta = {
      ...meta,
      columns: [column('we"ird;', "text", "text")],
      primaryKey: ['we"ird;'],
    };
    const built = selectPage("postgres", awkward, { schema: 's"x', table: "t;`" }, query());
    expect(built.text).toContain('"s""x"."t;`"');
    expect(built.text).toContain('"we""ird;"');
  });
});

describe("countRows and aggregate", () => {
  test("counts with the same where clause", () => {
    const built = countRows("mysql", meta, mysqlRef, {
      ref: mysqlRef,
      filters: [{ op: "eq", column: "id", value: "1" }],
      search: null,
    });
    expect(built.text).toBe("SELECT COUNT(*) FROM `grid` WHERE `id` = CAST(? AS SIGNED)");
    expect(built.params).toEqual(["1"]);
  });

  test("builds aggregates and rejects sum on non-numeric kinds", () => {
    const built = aggregate("postgres", meta, ref, {
      ref,
      filters: [],
      search: null,
      aggregates: [
        { fn: "count", column: null },
        { fn: "sum", column: "price" },
        { fn: "max", column: "at" },
      ],
    });
    expect(built.text).toContain("COUNT(*)");
    expect(built.text).toContain('SUM("price")');
    expect(built.text).toContain('MAX("at")::text');
    const error = invalid(() =>
      aggregate("postgres", meta, ref, {
        ref,
        filters: [],
        search: null,
        aggregates: [{ fn: "avg", column: "note" }],
      }),
    );
    expect(error.code).toBe("invalid_request");
  });
});

describe("edits", () => {
  test("builds the key predicate from text values", () => {
    const key = { id: "9007199254740993" };
    const pg = updateRow("postgres", meta, ref, key, { note: { set: "hi" } });
    expect(pg.text).toBe('UPDATE "public"."grid" SET "note" = $1::text WHERE "id" = $2::bigint');
    expect(pg.params).toEqual(["hi", "9007199254740993"]);

    const my = updateRow("mysql", meta, mysqlRef, key, { note: { set: "hi" } });
    expect(my.text).toBe("UPDATE `grid` SET `note` = ? WHERE `id` = CAST(? AS SIGNED)");
    expect(my.params).toEqual(["hi", "9007199254740993"]);
  });

  test("uses unsigned casts for unsigned MySQL keys", () => {
    const unsigned: TableMeta = {
      ...meta,
      columns: [column("id", "integer", "bigint unsigned")],
    };
    expect(lockRow("mysql", unsigned, mysqlRef, { id: "1" }).text).toBe(
      "SELECT 1 FROM `grid` WHERE `id` = CAST(? AS UNSIGNED) FOR UPDATE",
    );
  });

  test("locks, deletes and binds null and DEFAULT", () => {
    expect(lockRow("postgres", meta, ref, { id: "1" }).text).toBe(
      'SELECT 1 FROM "public"."grid" WHERE "id" = $1::bigint FOR UPDATE',
    );
    expect(deleteRow("mysql", meta, mysqlRef, { id: "1" }).text).toBe(
      "DELETE FROM `grid` WHERE `id` = CAST(? AS SIGNED)",
    );
    const update = updateRow(
      "postgres",
      meta,
      ref,
      { id: "1" },
      {
        note: { set: null },
        at: { useDefault: true },
      },
    );
    expect(update.text).toBe(
      'UPDATE "public"."grid" SET "note" = $1::text, "at" = DEFAULT WHERE "id" = $2::bigint',
    );
    expect(update.params).toEqual([null, "1"]);
  });

  test("builds inserts", () => {
    const built = insertRow("postgres", meta, ref, {
      note: { set: "a" },
      at: { useDefault: true },
    });
    expect(built.text).toBe(
      'INSERT INTO "public"."grid" ("note", "at") VALUES ($1::text, DEFAULT)',
    );
    expect(insertRow("postgres", meta, ref, {}).text).toBe(
      'INSERT INTO "public"."grid" DEFAULT VALUES',
    );
    expect(insertRow("mysql", meta, mysqlRef, {}).text).toBe("INSERT INTO `grid` () VALUES ()");
  });

  test("rejects a key that isn't the primary key", () => {
    expect(invalid(() => lockRow("postgres", meta, ref, { note: "x" })).code).toBe(
      "invalid_request",
    );
    expect(invalid(() => lockRow("postgres", meta, ref, { id: "1", note: "x" })).code).toBe(
      "invalid_request",
    );
  });

  test("rejects unknown and binary columns in values", () => {
    expect(invalid(() => insertRow("postgres", meta, ref, { nope: { set: "1" } })).code).toBe(
      "invalid_request",
    );
    expect(invalid(() => insertRow("postgres", meta, ref, { img: { set: "1" } })).code).toBe(
      "invalid_request",
    );
    expect(invalid(() => updateRow("postgres", meta, ref, { id: "1" }, {})).code).toBe(
      "invalid_request",
    );
  });

  test("selects one cell by key, casting non-text kinds", () => {
    expect(selectCell("postgres", meta, ref, { id: "1" }, "img").text).toBe(
      'SELECT "img" FROM "public"."grid" WHERE "id" = $1::bigint',
    );
    expect(selectCell("postgres", meta, ref, { id: "1" }, "tags").text).toBe(
      'SELECT "tags"::text FROM "public"."grid" WHERE "id" = $1::bigint',
    );
    expect(selectCell("mysql", meta, mysqlRef, { id: "1" }, "at").text).toBe(
      "SELECT CAST(`at` AS CHAR) FROM `grid` WHERE `id` = CAST(? AS SIGNED)",
    );
    expect(invalid(() => selectCell("mysql", meta, mysqlRef, { id: "1" }, "nope")).code).toBe(
      "invalid_request",
    );
  });

  test("writes bytes to a binary column only", () => {
    const bytes = new Uint8Array([1, 2]);
    const pg = updateCell("postgres", meta, ref, { id: "1" }, "img", bytes);
    expect(pg.text).toBe('UPDATE "public"."grid" SET "img" = $1::bytea WHERE "id" = $2::bigint');
    expect(pg.params).toEqual([bytes, "1"]);
    expect(invalid(() => updateCell("postgres", meta, ref, { id: "1" }, "note", bytes)).code).toBe(
      "invalid_request",
    );
  });

  test("never puts values or hostile identifiers into the text", () => {
    const hostile: TableMeta = {
      ...meta,
      columns: [column("id", "integer", "bigint"), column("a`;b", "text", "text")],
    };
    const built = updateRow(
      "mysql",
      hostile,
      mysqlRef,
      { id: "1" },
      {
        "a`;b": { set: "'; DROP TABLE grid; --" },
      },
    );
    expect(built.text).toBe("UPDATE `grid` SET `a``;b` = ? WHERE `id` = CAST(? AS SIGNED)");
    expect(built.text).not.toContain("DROP");
  });
});
