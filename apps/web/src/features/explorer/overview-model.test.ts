import { describe, expect, test } from "bun:test";
import type { ServerVariable } from "@dpilot/shared";
import { filterVariables, formatUptime } from "./overview-model.ts";

describe("formatUptime", () => {
  test("unknown uptime reads as a dash", () => expect(formatUptime(null)).toBe("—"));
  test("1 second", () => expect(formatUptime(1)).toBe("1 second"));
  test("45 seconds", () => expect(formatUptime(45)).toBe("45 seconds"));
  test("12 minutes", () => expect(formatUptime(720)).toBe("12 minutes"));
  test("3 hours 4 minutes", () => expect(formatUptime(11040)).toBe("3 hours 4 minutes"));
  test("2 days 5 hours", () => expect(formatUptime(190800)).toBe("2 days 5 hours"));
});

describe("filterVariables", () => {
  const vars: ServerVariable[] = [
    { name: "max_connections", value: "151", description: null },
    { name: "time_zone", value: "SYSTEM", description: null },
    { name: "sql_mode", value: "STRICT_TRANS_TABLES", description: null },
  ];

  test("matches name or value, ignoring case", () => {
    expect(filterVariables(vars, "ZONE").map((v) => v.name)).toEqual(["time_zone"]);
    expect(filterVariables(vars, "strict").map((v) => v.name)).toEqual(["sql_mode"]);
  });

  test("blank query returns everything", () => {
    expect(filterVariables(vars, "   ")).toEqual(vars);
  });
});
