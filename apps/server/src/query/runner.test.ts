import { describe, expect, test } from "bun:test";
import { type Dialect, splitStatements } from "@dpilot/shared";
import { DataError } from "../engines/types.ts";
import { FakeSession } from "../testing/fake-session.ts";
import { driverError } from "../testing/fake-sql.ts";
import { runScript } from "./runner.ts";

interface RunOptions {
  dialect?: Dialect;
  maxRows?: number;
  readOnly?: boolean;
  isCancelled?: () => boolean;
}

function run(session: FakeSession, sql: string, options: RunOptions = {}) {
  const dialect = options.dialect ?? "mysql";
  let clock = 0;
  return runScript(session, splitStatements(sql, dialect), {
    maxRows: options.maxRows ?? 1000,
    readOnly: options.readOnly ?? false,
    dialect,
    isCancelled: options.isCancelled ?? (() => false),
    now: () => {
      clock += 5;
      return clock;
    },
  });
}

describe("runScript", () => {
  test("runs statements in order and reports affected rows", async () => {
    const session = new FakeSession();
    session.respond(/^UPDATE/, { columns: [], rows: [], command: "UPDATE", affected: 3 });
    session.respond(/^SELECT/, {
      columns: ["a", "b"],
      rows: [[1, "x"]],
      command: null,
      affected: 1,
    });
    const result = await run(session, "UPDATE t SET a = 1; SELECT a, b FROM t");
    expect(session.executed).toEqual(["UPDATE t SET a = 1", "SELECT a, b FROM t"]);
    expect(result.outcomes[0]).toMatchObject({
      index: 0,
      kind: "affected",
      command: "UPDATE",
      affected: 3,
    });
    expect(result.outcomes[1]).toMatchObject({
      index: 1,
      kind: "rows",
      columns: [
        { name: "a", kind: "integer" },
        { name: "b", kind: "text" },
      ],
      rows: [[1, "x"]],
      truncated: false,
    });
    expect(result.summary).toEqual({ statements: 2, succeeded: 2, affected: 3 });
    expect(result.stopped).toBeNull();
    expect(result.durationMs).toBeGreaterThan(0);
  });

  test("stops at the first error with its position", async () => {
    const session = new FakeSession();
    session.respond(/^BAD/, driverError({ position: "5" }, "syntax error"));
    const result = await run(session, "SELECT 1; BAD stuff; SELECT 3", { dialect: "postgres" });
    expect(session.executed).toEqual(["SELECT 1", "BAD stuff"]);
    expect(result.outcomes[1]).toMatchObject({
      kind: "error",
      message: "syntax error",
      position: 4,
    });
    expect(result.stopped).toBe("error");
    expect(result.summary).toEqual({ statements: 2, succeeded: 1, affected: 0 });
  });

  test("reports a null position when the driver gives none", async () => {
    const session = new FakeSession();
    session.respond(/^BAD/, new Error("nope"));
    const result = await run(session, "BAD");
    expect(result.outcomes[0]).toMatchObject({ kind: "error", position: null });
  });

  test("truncates rows beyond maxRows", async () => {
    const session = new FakeSession();
    session.respond(/^SELECT/, {
      columns: ["n"],
      rows: [[1], [2], [3]],
      command: null,
      affected: null,
    });
    const result = await run(session, "SELECT n FROM t", { maxRows: 2 });
    expect(result.outcomes[0]).toMatchObject({ rows: [[1], [2]], truncated: true });
  });

  test("encodes cells and infers column kinds", async () => {
    const session = new FakeSession();
    session.respond(/^SELECT/, {
      columns: ["big", "when", "blob", "nothing"],
      rows: [[2n ** 60n, new Date("2024-01-02T03:04:05Z"), new Uint8Array([1, 2]), null]],
      command: null,
      affected: null,
    });
    const result = await run(session, "SELECT 1");
    expect(result.outcomes[0]).toMatchObject({
      columns: [
        { name: "big", kind: "integer" },
        { name: "when", kind: "datetime" },
        { name: "blob", kind: "binary" },
        { name: "nothing", kind: "other" },
      ],
      rows: [
        [
          "1152921504606846976",
          "2024-01-02T03:04:05.000Z",
          { bytes: { size: 2, hex: "0102", truncated: false } },
          null,
        ],
      ],
    });
  });

  test("keeps the first and last 50 outcomes", async () => {
    const session = new FakeSession();
    const sql = Array.from({ length: 130 }, (_, i) => `SELECT ${i}`).join(";");
    const result = await run(session, sql);
    expect(result.outcomes).toHaveLength(100);
    expect(result.omitted).toBe(30);
    expect(result.outcomes[49]?.index).toBe(49);
    expect(result.outcomes[50]?.index).toBe(80);
    expect(result.outcomes[99]?.index).toBe(129);
    expect(result.summary.statements).toBe(130);
    expect(result.summary.succeeded).toBe(130);
  });

  test("wraps statements in a read-only transaction", async () => {
    const mysql = new FakeSession();
    await run(mysql, "SELECT 1; SHOW TABLES", { readOnly: true });
    expect(mysql.executed).toEqual([
      "START TRANSACTION READ ONLY",
      "SELECT 1",
      "ROLLBACK",
      "START TRANSACTION READ ONLY",
      "SHOW TABLES",
      "ROLLBACK",
    ]);
    const postgres = new FakeSession();
    await run(postgres, "SELECT 1", { readOnly: true, dialect: "postgres" });
    expect(postgres.executed).toEqual(["BEGIN READ ONLY", "SELECT 1", "ROLLBACK"]);
  });

  test("rolls back a read-only statement that fails", async () => {
    const session = new FakeSession();
    session.respond(/^SELECT boom/, new Error("boom"));
    const result = await run(session, "SELECT boom", { readOnly: true });
    expect(session.executed).toEqual(["START TRANSACTION READ ONLY", "SELECT boom", "ROLLBACK"]);
    expect(result.stopped).toBe("error");
  });

  test("refuses anything but reads before running a statement", async () => {
    const session = new FakeSession();
    const attempt = run(session, "SELECT 1; DELETE FROM t WHERE id = 1", { readOnly: true });
    await expect(attempt).rejects.toBeInstanceOf(DataError);
    expect(session.executed).toEqual([]);
  });

  test("stops before the next statement once cancelled", async () => {
    const session = new FakeSession();
    const result = await run(session, "SELECT 1; SELECT 2; SELECT 3", {
      isCancelled: () => session.executed.length >= 1,
    });
    expect(session.executed).toEqual(["SELECT 1"]);
    expect(result.outcomes).toHaveLength(1);
    expect(result.stopped).toBe("cancelled");
  });

  test("marks the run cancelled when the last statement is interrupted but returns normally", async () => {
    const session = new FakeSession();
    const result = await run(session, "SELECT SLEEP(5)", {
      isCancelled: () => session.executed.length >= 1,
    });
    expect(session.executed).toEqual(["SELECT SLEEP(5)"]);
    expect(result.stopped).toBe("cancelled");
  });

  test("marks the run cancelled when the in-flight statement fails after a cancel", async () => {
    const session = new FakeSession();
    session.respond(/^SELECT 2$/, new Error("Query execution was interrupted"));
    const result = await run(session, "SELECT 1; SELECT 2; SELECT 3", {
      isCancelled: () => session.executed.length >= 2,
    });
    expect(session.executed).toEqual(["SELECT 1", "SELECT 2"]);
    expect(result.stopped).toBe("cancelled");
    expect(result.outcomes[1]).toMatchObject({ kind: "error" });
  });
});
