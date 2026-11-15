import { describe, expect, test } from "bun:test";
import { databaseHref, parseExplorerPath, targetHref } from "./paths.ts";

describe("explorer paths", () => {
  test("a target path gives the target", () => {
    expect(parseExplorerPath("/c/s.app")).toEqual({ target: "s.app", db: null });
  });

  test("a database path gives the target and database", () => {
    expect(parseExplorerPath("/c/s.app/db/shop")).toEqual({ target: "s.app", db: "shop" });
  });

  test("database names with slashes, percent signs and spaces round-trip", () => {
    for (const db of ["a/b", "100%", "a%2Fb", "my db", "naïve#1?"]) {
      expect(parseExplorerPath(databaseHref("s.app", db))).toEqual({ target: "s.app", db });
    }
  });

  test("target hrefs round-trip", () => {
    expect(parseExplorerPath(targetHref("c.0b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11"))).toEqual({
      target: "c.0b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11",
      db: null,
    });
  });

  test("other shapes and broken escapes are not explorer paths", () => {
    expect(parseExplorerPath("/c/")).toBeNull();
    expect(parseExplorerPath("/c/s.app/tables")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/a/b")).toBeNull();
    expect(parseExplorerPath("/c/s.app/db/%E0%A4%A")).toBeNull();
  });
});
