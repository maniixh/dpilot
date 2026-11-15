import { beforeEach, describe, expect, test } from "bun:test";
import type { TableRef } from "@dpilot/shared";
import type { DataAdapter } from "../engines/types.ts";
import { DataError, TargetError } from "../engines/types.ts";
import { driverError, type FakeSqlFactory } from "./fake-sql.ts";

export interface TableScript {
  view?: boolean;
  /** Unique keys, the first being the primary key when `primary` is true. */
  keys: string[][];
  primary?: boolean;
  /** Column names that are nullable; defaults to note and img. */
  nullable?: string[];
}

/** One engine's wiring for the behaviours both data adapters must share. */
export interface DataHarness {
  sql: FakeSqlFactory;
  db: string;
  ref: TableRef;
  adapter(readOnly: boolean): DataAdapter;
  /** Scripts the catalog for a table with columns id (bigint), note (text), img (blob). */
  script(table: TableScript): void;
  /** Matches the catalog queries that describe a table. */
  catalog: RegExp;
}

/** Primary-key columns are NOT NULL; otherwise `nullable` (default: note and img) decides. */
export function isNullable(table: TableScript, name: string): boolean {
  if (table.primary && table.keys[0]?.includes(name)) return false;
  return (table.nullable ?? ["note", "img"]).includes(name);
}

const LOCKED = { columns: ["1"], rows: [[1]], command: null, affected: null };
const TWO_LOCKED = { columns: ["1"], rows: [[1], [1]], command: null, affected: null };
const AFFECTED_ONE = { columns: [], rows: [], command: null, affected: 1 };
const AFFECTED_NONE = { columns: [], rows: [], command: null, affected: 0 };

export function defineDataAdapterContract(label: string, setup: () => DataHarness): void {
  describe(`${label} data adapter`, () => {
    let h: DataHarness;
    beforeEach(() => {
      h = setup();
    });

    const writes = () =>
      h.sql.calls
        .map((call) => call.text)
        .filter((text) => /^(BEGIN|COMMIT|ROLLBACK|UPDATE|DELETE)|FOR UPDATE/.test(text));

    test("reports a table's columns, kinds and primary key", async () => {
      h.script({ keys: [["id"]], primary: true });
      const meta = await h.adapter(false).table(h.db, h.ref);
      expect(meta.kind).toBe("table");
      expect(meta.primaryKey).toEqual(["id"]);
      expect(meta.editable).toBe(true);
      expect(meta.readOnlyReason).toBeNull();
      expect(meta.columns.map((c) => [c.name, c.kind, c.nullable])).toEqual([
        ["id", "integer", false],
        ["note", "text", true],
        ["img", "binary", true],
      ]);
    });

    test("marks a table without a primary key read-only", async () => {
      h.script({ keys: [] });
      const meta = await h.adapter(false).table(h.db, h.ref);
      expect(meta.editable).toBe(false);
      expect(meta.readOnlyReason).toBe(
        "This table has no primary key, so rows can't be told apart.",
      );
    });

    test("uses a unique non-null key when there is no primary key", async () => {
      h.script({ keys: [["note"], ["id"]], nullable: ["note"] });
      const meta = await h.adapter(false).table(h.db, h.ref);
      expect(meta.primaryKey).toEqual(["id"]);
      expect(meta.editable).toBe(true);
    });

    test("marks a view and a binary key as not editable", async () => {
      h.script({ view: true, keys: [] });
      const view = await h.adapter(false).table(h.db, h.ref);
      expect([view.kind, view.editable, view.readOnlyReason]).toEqual([
        "view",
        false,
        "This is a view.",
      ]);

      h.sql.calls.length = 0;
      h.script({ keys: [["img"]], primary: true });
      const binary = await h.adapter(false).table(h.db, h.ref);
      expect(binary.editable).toBe(false);
      expect(binary.readOnlyReason).toBe("Binary primary keys aren't supported for editing.");
    });

    test("marks every table read-only on a read-only connection", async () => {
      h.script({ keys: [["id"]], primary: true });
      const meta = await h.adapter(true).table(h.db, h.ref);
      expect(meta.editable).toBe(false);
      expect(meta.readOnlyReason).toBe("This connection is read-only.");
      expect(meta.primaryKey).toEqual(["id"]);
    });

    test("rejects every mutation as read_only before sending any SQL", async () => {
      const adapter = h.adapter(true);
      const key = { id: "1" };
      const attempts = [
        () => adapter.insert(h.db, { ref: h.ref, values: {} }),
        () => adapter.update(h.db, { ref: h.ref, key, values: { note: { set: "x" } } }),
        () => adapter.remove(h.db, { ref: h.ref, keys: [key] }),
        () => adapter.writeCell(h.db, h.ref, key, "img", new Uint8Array([1])),
      ];
      for (const attempt of attempts) {
        const error = await attempt().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DataError);
        expect((error as DataError).code).toBe("read_only");
      }
      expect(h.sql.calls).toEqual([]);
    });

    test("rejects edits on a table that isn't editable", async () => {
      h.script({ keys: [] });
      const error = await h
        .adapter(false)
        .update(h.db, { ref: h.ref, key: { id: "1" }, values: { note: { set: "x" } } })
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("not_editable");
      expect(writes()).toEqual([]);
    });

    test("rows returns keys from the __k aliases", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/LIMIT/, {
        columns: ["id", "note", "img", "__k0"],
        rows: [
          [9007199254740993n, "a", new Uint8Array([255]), "9007199254740993"],
          [2n, null, null, "2"],
        ],
        command: null,
        affected: null,
      });
      const page = await h.adapter(false).rows(h.db, {
        ref: h.ref,
        filters: [],
        search: null,
        sort: [],
        offset: 0,
        limit: 10,
      });
      expect(page.keys).toEqual([{ id: "9007199254740993" }, { id: "2" }]);
      expect(page.rows).toEqual([
        ["9007199254740993", "a", { bytes: { size: 1, hex: "ff", truncated: false } }],
        [2, null, null],
      ]);
    });

    test("rows has no keys when the table isn't editable", async () => {
      h.script({ keys: [] });
      h.sql.respondExecute(/LIMIT/, {
        columns: ["id", "note", "img"],
        rows: [[1n, "a", null]],
        command: null,
        affected: null,
      });
      const page = await h.adapter(false).rows(h.db, {
        ref: h.ref,
        filters: [],
        search: null,
        sort: [],
        offset: 0,
        limit: 10,
      });
      expect(page.keys).toBeNull();
      expect(page.rows).toEqual([[1, "a", null]]);
    });

    test("counts and aggregates", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/COUNT\(\*\)/, {
        columns: ["c"],
        rows: [[12n]],
        command: null,
        affected: null,
      });
      const adapter = h.adapter(false);
      expect(await adapter.count(h.db, { ref: h.ref, filters: [], search: null })).toBe(12);
      const result = await adapter.aggregate(h.db, {
        ref: h.ref,
        filters: [],
        search: null,
        aggregates: [{ fn: "count", column: null }],
      });
      expect(result.values).toEqual([12]);
    });

    test("update locks the row first and rolls back when it is missing", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, { ...LOCKED, rows: [] });
      const error = await h
        .adapter(false)
        .update(h.db, { ref: h.ref, key: { id: "1" }, values: { note: { set: "x" } } })
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("row_not_found");
      expect(writes().map((text) => text.replace(/^(SELECT).*/, "LOCK"))).toEqual([
        "BEGIN",
        "LOCK",
        "ROLLBACK",
      ]);
    });

    test("update rolls back when the key matches two rows", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, TWO_LOCKED);
      const error = await h
        .adapter(false)
        .update(h.db, { ref: h.ref, key: { id: "1" }, values: { note: { set: "x" } } })
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("key_not_unique");
      expect(writes().at(-1)).toBe("ROLLBACK");
      expect(writes().some((text) => text.startsWith("UPDATE"))).toBe(false);
    });

    test("update rolls back when it affects more than one row", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, LOCKED);
      h.sql.respondExecute(/^UPDATE/, { ...AFFECTED_ONE, affected: 2 });
      const error = await h
        .adapter(false)
        .update(h.db, { ref: h.ref, key: { id: "1" }, values: { note: { set: "x" } } })
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("row_not_found");
      expect(writes().at(-1)).toBe("ROLLBACK");
    });

    test("update commits after locking and updating one row", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, LOCKED);
      h.sql.respondExecute(/^UPDATE/, AFFECTED_ONE);
      const result = await h
        .adapter(false)
        .update(h.db, { ref: h.ref, key: { id: "1" }, values: { note: { set: "x" } } });
      expect(result).toEqual({ affected: 1 });
      expect(writes().map((text) => text.split(" ")[0])).toEqual([
        "BEGIN",
        "SELECT",
        "UPDATE",
        "COMMIT",
      ]);
    });

    test("an invalid edit fails before the transaction starts", async () => {
      h.script({ keys: [["id"]], primary: true });
      const error = await h
        .adapter(false)
        .update(h.db, { ref: h.ref, key: { id: "1" }, values: { nope: { set: "x" } } })
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("invalid_request");
      expect(writes()).toEqual([]);
    });

    test("remove locks and deletes each key in one transaction", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, LOCKED);
      h.sql.respondExecute(/^DELETE/, AFFECTED_ONE);
      const result = await h
        .adapter(false)
        .remove(h.db, { ref: h.ref, keys: [{ id: "1" }, { id: "2" }] });
      expect(result).toEqual({ affected: 2 });
      expect(writes().map((text) => text.split(" ")[0])).toEqual([
        "BEGIN",
        "SELECT",
        "DELETE",
        "SELECT",
        "DELETE",
        "COMMIT",
      ]);
    });

    test("remove rolls back everything when a delete affects no row", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, LOCKED);
      h.sql.respondExecute(/^DELETE/, AFFECTED_NONE);
      const error = await h
        .adapter(false)
        .remove(h.db, { ref: h.ref, keys: [{ id: "1" }, { id: "2" }] })
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("row_not_found");
      expect(writes().at(-1)).toBe("ROLLBACK");
    });

    test("insert reports the affected row", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/^INSERT/, AFFECTED_ONE);
      const result = await h
        .adapter(false)
        .insert(h.db, { ref: h.ref, values: { note: { set: "x" } } });
      expect(result).toEqual({ affected: 1 });
    });

    test("reads a text cell as UTF-8 bytes and a binary cell as is", async () => {
      h.script({ keys: [["id"]], primary: true });
      const adapter = h.adapter(false);
      h.sql.respondExecute(/^SELECT "?`?note/, {
        columns: ["note"],
        rows: [["héllo"]],
        command: null,
        affected: null,
      });
      const text = await adapter.readCell(h.db, h.ref, { id: "1" }, "note");
      expect(new TextDecoder().decode(text)).toBe("héllo");

      h.sql.respondExecute(/^SELECT "?`?img/, {
        columns: ["img"],
        rows: [[new Uint8Array([1, 2, 3])]],
        command: null,
        affected: null,
      });
      expect([...(await adapter.readCell(h.db, h.ref, { id: "1" }, "img"))]).toEqual([1, 2, 3]);
    });

    test("readCell fails with row_not_found when no row matches", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/^SELECT "?`?note/, { ...LOCKED, rows: [] });
      const error = await h
        .adapter(false)
        .readCell(h.db, h.ref, { id: "1" }, "note")
        .catch((caught: unknown) => caught);
      expect((error as DataError).code).toBe("row_not_found");
    });

    test("writeCell locks the row and stores the bytes", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, LOCKED);
      h.sql.respondExecute(/^UPDATE/, AFFECTED_ONE);
      const bytes = new Uint8Array([9, 8]);
      const result = await h.adapter(false).writeCell(h.db, h.ref, { id: "1" }, "img", bytes);
      expect(result).toEqual({ affected: 1 });
      const update = h.sql.calls.find((call) => call.text.startsWith("UPDATE"));
      expect(update?.params[0]).toBe(bytes);
    });

    test("binds the table name only as a parameter in metadata queries", async () => {
      const hostile: TableRef = { ...h.ref, table: "orders'; DROP TABLE x; --" };
      h.script({ keys: [["id"]], primary: true });
      await h.adapter(false).table(h.db, hostile);
      const catalogCalls = h.sql.calls.filter((call) => h.catalog.test(call.text));
      expect(catalogCalls.length).toBeGreaterThan(0);
      for (const call of catalogCalls) {
        expect(call.text).not.toContain("orders");
        expect(call.params).toContain(hostile.table);
      }
    });

    test("an unknown table is target_not_found", async () => {
      const error = await h
        .adapter(false)
        .table(h.db, { ...h.ref, table: "missing" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TargetError);
      expect((error as TargetError).code).toBe("target_not_found");
      expect((error as TargetError).message).toBe("No table named missing.");
    });

    test("caches metadata and drops it after an edit", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/FOR UPDATE/, LOCKED);
      h.sql.respondExecute(/^UPDATE/, AFFECTED_ONE);
      const adapter = h.adapter(false);
      const catalogQueries = () => h.sql.calls.filter((c) => h.catalog.test(c.text)).length;
      await adapter.table(h.db, h.ref);
      await adapter.table(h.db, h.ref);
      const cached = catalogQueries();
      await adapter.update(h.db, {
        ref: h.ref,
        key: { id: "1" },
        values: { note: { set: "x" } },
      });
      expect(catalogQueries()).toBe(cached);
      await adapter.table(h.db, h.ref);
      expect(catalogQueries()).toBe(cached * 2);
    });

    test("maps engine failures through the shared error mapping", async () => {
      h.script({ keys: [["id"]], primary: true });
      h.sql.respondExecute(/LIMIT/, driverError({ code: "ECONNREFUSED" }));
      const error = await h
        .adapter(false)
        .rows(h.db, { ref: h.ref, filters: [], search: null, sort: [], offset: 0, limit: 1 })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TargetError);
      expect((error as TargetError).code).toBe("unreachable");
    });

    test("completion lists columns per table", async () => {
      h.sql.respond(/information_schema/i, [
        { tableName: "a", columnName: "id" },
        { tableName: "a", columnName: "x" },
        { tableName: "b", columnName: "id" },
      ]);
      expect(await h.adapter(false).completion(h.db, null)).toEqual({
        a: ["id", "x"],
        b: ["id"],
      });
    });
  });
}
