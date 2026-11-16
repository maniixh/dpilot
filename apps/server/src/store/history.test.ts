import { beforeEach, expect, test } from "bun:test";
import type { HistoryEntry } from "@dpilot/shared";
import { openStore } from "./database.ts";
import { createHistoryStore } from "./history.ts";
import type { HistoryStore } from "./types.ts";

const A = "s.alpha";
const B = "s.beta";

function entry(overrides: Partial<Omit<HistoryEntry, "id">> = {}): Omit<HistoryEntry, "id"> {
  return {
    target: A,
    database: "app",
    sql: "SELECT 1",
    startedAt: "2026-11-15T00:00:00.000Z",
    durationMs: 5,
    outcome: "ok",
    statements: 1,
    rowsAffected: 0,
    error: null,
    ...overrides,
  };
}

let db: ReturnType<typeof openStore>;
let store: HistoryStore;

beforeEach(() => {
  db = openStore(":memory:");
  store = createHistoryStore(db, { max: 3 });
});

test("stores redacted SQL", () => {
  const added = store.add(entry({ sql: "CREATE USER x IDENTIFIED BY 'pw'" }));
  expect(added.sql).not.toContain("pw");
  const stored = db.query("SELECT sql FROM query_history").get() as { sql: string };
  expect(stored.sql).not.toContain("pw");
});

test("hides a secret quoted in the driver error", () => {
  const error =
    "You have an error in your SQL syntax; check the manual near 'CREAT USER bob " +
    "IDENTIFIED BY 'hunter2'' at line 1";
  const added = store.add(entry({ outcome: "error", error }));
  expect(added.error).not.toContain("hunter2");
  const stored = db.query("SELECT error FROM query_history").get() as { error: string };
  expect(stored.error).not.toContain("hunter2");
});

test("keeps an error without secrets and caps its length", () => {
  expect(store.add(entry({ outcome: "error", error: "Unknown column 'x'" })).error).toBe(
    "Unknown column 'x'",
  );
  expect(store.add(entry({ outcome: "error", error: "e".repeat(5000) })).error).toHaveLength(2000);
});

test("truncates SQL to 100000 characters", () => {
  const added = store.add(entry({ sql: `SELECT '${"x".repeat(200_000)}'` }));
  expect(added.sql.length).toBe(100_000);
});

test("returns the stored entry with an id", () => {
  const first = store.add(entry({ error: "boom", outcome: "error" }));
  expect(first).toMatchObject({ target: A, outcome: "error", error: "boom" });
  expect(store.add(entry()).id).toBeGreaterThan(first.id);
});

test("prunes beyond max", () => {
  for (let i = 1; i <= 5; i++) store.add(entry({ sql: `SELECT ${i}` }));
  const kept = store.list({ limit: 50 }).map((e) => e.sql);
  expect(kept).toEqual(["SELECT 5", "SELECT 4", "SELECT 3"]);
});

test("lists newest first with search and before", () => {
  const ids: [number, number, number] = [
    store.add(entry({ sql: "SELECT a" })).id,
    store.add(entry({ sql: "UPDATE t SET b = 1" })).id,
    store.add(entry({ sql: "SELECT b", target: B })).id,
  ];
  expect(store.list({ limit: 50 }).map((e) => e.id)).toEqual([...ids].reverse());
  expect(store.list({ limit: 50, search: "select" }).map((e) => e.id)).toEqual([ids[2], ids[0]]);
  expect(store.list({ limit: 50, target: A }).map((e) => e.id)).toEqual([ids[1], ids[0]]);
  expect(store.list({ limit: 50, before: ids[2] }).map((e) => e.id)).toEqual([ids[1], ids[0]]);
  expect(store.list({ limit: 1 }).map((e) => e.id)).toEqual([ids[2]]);
});

test("search treats % and _ literally", () => {
  store.add(entry({ sql: "SELECT 100" }));
  const hit = store.add(entry({ sql: "SELECT '50%'" }));
  expect(store.list({ limit: 50, search: "50%" }).map((e) => e.id)).toEqual([hit.id]);
});

test("remove deletes one entry", () => {
  const first = store.add(entry());
  const second = store.add(entry());
  store.remove(first.id);
  expect(store.list({ limit: 50 }).map((e) => e.id)).toEqual([second.id]);
});

test("clear(target) only clears that target", () => {
  store.add(entry());
  const other = store.add(entry({ target: B }));
  store.clear(A);
  expect(store.list({ limit: 50 }).map((e) => e.id)).toEqual([other.id]);
  store.clear(null);
  expect(store.list({ limit: 50 })).toEqual([]);
});
