import { describe, expect, test } from "bun:test";
import { connectionInputSchema } from "./connections.ts";
import {
  aggregateRequestSchema,
  dialectOf,
  filterSchema,
  rowKeySchema,
  rowsQuerySchema,
} from "./data.ts";
import { queryRequestSchema } from "./query.ts";

const ref = { schema: null, table: "t" };
const rowsQuery = { ref, filters: [], search: null, sort: [], offset: 0, limit: 1000 };
const uuid = "6f1f0c1e-7d57-4a8f-9d55-0a4c3f1b2e10";

describe("rowsQuerySchema", () => {
  test("accepts limit 1000 and rejects 1001", () => {
    expect(rowsQuerySchema.safeParse(rowsQuery).success).toBe(true);
    expect(rowsQuerySchema.safeParse({ ...rowsQuery, limit: 1001 }).success).toBe(false);
  });
});

describe("filterSchema", () => {
  test("requires a value for eq and forbids one for is_null", () => {
    expect(filterSchema.safeParse({ op: "eq", column: "a" }).success).toBe(false);
    expect(filterSchema.safeParse({ op: "eq" }).success).toBe(false);
    const withValue = { op: "is_null", column: "a", value: "x" };
    expect(filterSchema.safeParse(withValue).success).toBe(false);
    expect(filterSchema.safeParse({ op: "is_null", column: "a" }).success).toBe(true);
  });

  test("limits in-lists to 1-100 values", () => {
    const list = (count: number) => ({
      op: "in",
      column: "a",
      values: Array.from({ length: count }, (_, i) => String(i)),
    });
    expect(filterSchema.safeParse(list(1)).success).toBe(true);
    expect(filterSchema.safeParse(list(100)).success).toBe(true);
    expect(filterSchema.safeParse(list(101)).success).toBe(false);
  });
});

describe("rowKeySchema", () => {
  test("keeps key values as text", () => {
    expect(rowKeySchema.safeParse({ id: 5 }).success).toBe(false);
    expect(rowKeySchema.safeParse({ id: "9007199254740993" }).success).toBe(true);
    expect(rowKeySchema.safeParse({}).success).toBe(false);
  });
});

describe("aggregateRequestSchema", () => {
  test("allows a null column only for count", () => {
    const request = (fn: string) => ({
      ref,
      filters: [],
      search: null,
      aggregates: [{ fn, column: null }],
    });
    expect(aggregateRequestSchema.safeParse(request("count")).success).toBe(true);
    expect(aggregateRequestSchema.safeParse(request("sum")).success).toBe(false);
  });
});

describe("queryRequestSchema", () => {
  const request = { runId: uuid, sql: "SELECT 1", database: null, tab: uuid, confirmed: false };

  test("defaults maxRows and rejects bad ids and limits", () => {
    expect(queryRequestSchema.parse(request).maxRows).toBe(1000);
    expect(queryRequestSchema.safeParse({ ...request, runId: "nope" }).success).toBe(false);
    expect(queryRequestSchema.safeParse({ ...request, maxRows: 10_001 }).success).toBe(false);
  });
});

describe("dialectOf", () => {
  test("maps MariaDB to the mysql dialect", () => {
    expect(dialectOf("mariadb")).toBe("mysql");
    expect(dialectOf("postgres")).toBe("postgres");
  });
});

describe("connectionInputSchema", () => {
  test("accepts readOnly", () => {
    const input = {
      label: "x",
      engine: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      tls: { mode: "off", ca: null },
      readOnly: true,
    };
    expect(connectionInputSchema.safeParse(input).success).toBe(true);
  });
});
