import { beforeEach, expect, test } from "bun:test";
import type { SavedQueryInput } from "@dpilot/shared";
import { openStore } from "./database.ts";
import { createSavedQueryStore } from "./saved-queries.ts";
import type { SavedQueryStore } from "./types.ts";

const input: SavedQueryInput = {
  name: "Active users",
  target: "s.alpha",
  database: "app",
  sql: "SELECT * FROM users",
};

let store: SavedQueryStore;
let clock: number;
let ids: number;

beforeEach(() => {
  clock = Date.parse("2026-11-15T00:00:00Z");
  ids = 0;
  store = createSavedQueryStore(openStore(":memory:"), {
    now: () => new Date(clock),
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
});

test("creates and lists saved queries by name", () => {
  const created = store.create(input);
  expect(created).toMatchObject({ ...input, createdAt: "2026-11-15T00:00:00.000Z" });
  store.create({ ...input, name: "Archived", target: null, database: null });
  expect(store.list().map((q) => q.name)).toEqual(["Active users", "Archived"]);
});

test("rejects a duplicate name with name_taken", () => {
  store.create(input);
  expect(() => store.create(input)).toThrow(expect.objectContaining({ code: "name_taken" }));
});

test("update bumps updatedAt", () => {
  const created = store.create(input);
  clock += 60_000;
  const updated = store.update(created.id, { sql: "SELECT 1" });
  expect(updated).toMatchObject({ sql: "SELECT 1", name: input.name });
  expect(updated.createdAt).toBe(created.createdAt);
  expect(updated.updatedAt).toBe("2026-11-15T00:01:00.000Z");
});

test("update rejects a name that another query uses", () => {
  store.create(input);
  const other = store.create({ ...input, name: "Other" });
  expect(() => store.update(other.id, { name: input.name })).toThrow(
    expect.objectContaining({ code: "name_taken" }),
  );
});

test("update and remove unknown → not_found", () => {
  expect(() => store.update("nope", { sql: "x" })).toThrow(
    expect.objectContaining({ code: "not_found" }),
  );
  expect(() => store.remove("nope")).toThrow(expect.objectContaining({ code: "not_found" }));
});

test("remove deletes the query", () => {
  const created = store.create(input);
  store.remove(created.id);
  expect(store.list()).toEqual([]);
});
