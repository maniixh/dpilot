import { expect, test } from "bun:test";
import type { ConnectionConfig } from "../connections/types.ts";
import { driverError } from "../testing/fake-sql.ts";
import { classifyError, isPermissionDenied } from "./errors.ts";

const config: ConnectionConfig = {
  engine: "postgres",
  host: "db.example.com",
  port: 5432,
  username: "root",
  password: "x",
  database: null,
  tls: { mode: "off", ca: null },
};
const external = { managed: false };

test.each([
  [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "28P01" }, "auth_failed"],
  [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "28000" }, "auth_failed"],
  [{ code: "ERR_MYSQL_SERVER_ERROR", errno: 1045 }, "auth_failed"],
  [{ code: "ECONNREFUSED" }, "unreachable"],
  [{ code: "ENOTFOUND" }, "unreachable"],
  [{ code: "ERR_POSTGRES_CONNECTION_REFUSED" }, "unreachable"],
  [{ code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }, "timeout"],
  [{ code: "ETIMEDOUT" }, "timeout"],
  [{ code: "ERR_POSTGRES_TLS_NOT_AVAILABLE" }, "tls_failed"],
  [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "42P01" }, "query_failed"],
] as const)("classifies %p as %s", (fields, code) => {
  expect(classifyError(driverError(fields), config, external).code).toBe(code);
});

test("uses the spec's messages", () => {
  expect(classifyError(driverError({ errno: 1045 }), config, external).message).toBe(
    "The server rejected user root. Check the user and password.",
  );
  expect(classifyError(driverError({ code: "ECONNREFUSED" }), config, external).message).toBe(
    "Nothing answered at db.example.com:5432. Check the host and port.",
  );
  expect(classifyError(driverError({ code: "ETIMEDOUT" }), config, external).message).toBe(
    "The server didn't answer within 10 seconds.",
  );
});

test("keeps the driver message for query failures", () => {
  const error = classifyError(new Error("boom"), config, external);
  expect(error).toMatchObject({ code: "query_failed", message: "boom" });
});

test("adds the Dpilot server hint to auth failures", () => {
  const error = classifyError(driverError({ errno: "28P01" }), config, { managed: true });
  expect(error.message).toContain("the password the server was created with");
});

test("passes an existing TargetError through", () => {
  const first = classifyError(driverError({ code: "ETIMEDOUT" }), config, external);
  expect(classifyError(first, config, external)).toBe(first);
});

test.each([
  [{ errno: "42501" }, true],
  [{ errno: 1044 }, true],
  [{ errno: 1227 }, true],
  [{ errno: 1045 }, false],
])("isPermissionDenied(%p)", (fields, expected) => {
  expect(isPermissionDenied(driverError(fields))).toBe(expected);
});
