import { describe, expect, test } from "bun:test";
import type { ServerVariable, TargetSummary, TargetsResponse } from "@dpilot/shared";
import { filterVariables, findTarget, formatUptime } from "./overview-model.ts";

describe("formatUptime", () => {
  test("unknown uptime reads as a dash", () => expect(formatUptime(null)).toBe("—"));
  test("1 second", () => expect(formatUptime(1)).toBe("1 second"));
  test("45 seconds", () => expect(formatUptime(45)).toBe("45 seconds"));
  test("12 minutes", () => expect(formatUptime(720)).toBe("12 minutes"));
  test("3 hours 4 minutes", () => expect(formatUptime(11040)).toBe("3 hours 4 minutes"));
  test("2 days 5 hours", () => expect(formatUptime(190800)).toBe("2 days 5 hours"));
});

describe("findTarget", () => {
  const mysql: TargetSummary = {
    id: "s.one",
    kind: "server",
    label: "one",
    engine: "mysql",
    available: true,
  };
  const saved: TargetSummary = {
    id: "c.00000000-0000-4000-8000-000000000001",
    kind: "connection",
    label: "Prod",
    engine: "postgres",
    available: true,
  };
  const ok: TargetsResponse = {
    servers: { status: "ok", targets: [mysql] },
    connections: [saved],
  };
  const down: TargetsResponse = {
    servers: { status: "unavailable", message: "Docker isn't running." },
    connections: [saved],
  };

  test("finds Dpilot servers and saved connections", () => {
    expect(findTarget(ok, "s.one")).toEqual({ status: "found", summary: mysql });
    expect(findTarget(down, saved.id)).toEqual({ status: "found", summary: saved });
  });

  test("reports an unknown target as missing", () => {
    expect(findTarget(ok, "s.gone")).toEqual({ status: "missing" });
    expect(findTarget(ok, "c.00000000-0000-4000-8000-000000000009")).toEqual({
      status: "missing",
    });
  });

  test("reports a Dpilot server as unavailable while Docker is", () => {
    expect(findTarget(down, "s.one")).toEqual({
      status: "unavailable",
      message: "Docker isn't running.",
    });
  });
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
