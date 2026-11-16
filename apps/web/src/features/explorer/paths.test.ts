import { describe, expect, test } from "bun:test";
import { databaseHref, editorHref, parseExplorerPath, tableHref, targetHref } from "./paths.ts";

describe("explorer paths", () => {
  test("a target path gives the target", () => {
    expect(parseExplorerPath("/c/s.app")).toEqual({ kind: "target", target: "s.app" });
  });

  test("a database path gives the target and database", () => {
    expect(parseExplorerPath("/c/s.app/db/shop")).toEqual({
      kind: "database",
      target: "s.app",
      db: "shop",
    });
  });

  test("database names with slashes, percent signs and spaces round-trip", () => {
    for (const db of ["a/b", "100%", "a%2Fb", "my db", "naïve#1?"]) {
      expect(parseExplorerPath(databaseHref("s.app", db))).toEqual({
        kind: "database",
        target: "s.app",
        db,
      });
    }
  });

  test("target hrefs round-trip", () => {
    expect(parseExplorerPath(targetHref("c.0b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11"))).toEqual({
      kind: "target",
      target: "c.0b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11",
    });
  });

  test("tableHref round-trips names with slashes and quotes", () => {
    expect(parseExplorerPath(tableHref("c.x", "a/b", 's"1', "t%20 ü"))).toEqual({
      kind: "table",
      target: "c.x",
      db: "a/b",
      schema: 's"1',
      table: "t%20 ü",
    });
  });

  test("tableHref without a schema", () => {
    const href = tableHref("s.app", "shop", null, "orders");
    expect(href).toBe("/c/s.app/db/shop/table/orders");
    expect(parseExplorerPath(href)).toEqual({
      kind: "table",
      target: "s.app",
      db: "shop",
      schema: null,
      table: "orders",
    });
  });

  test("editorHref with and without db", () => {
    expect(parseExplorerPath(editorHref("s.app", null))).toEqual({
      kind: "editor",
      target: "s.app",
      db: null,
    });
    expect(parseExplorerPath(editorHref("s.app", "my/db"))).toEqual({
      kind: "editor",
      target: "s.app",
      db: "my/db",
    });
  });

  test("other shapes and broken escapes are not explorer paths", () => {
    expect(parseExplorerPath("/c/")).toBeNull();
    expect(parseExplorerPath("/c/s.app/tables")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/a/b")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/%E0%A4%A")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/shop/table/")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/shop/table/%E0%A4%A")).toBeNull();
  });
});
