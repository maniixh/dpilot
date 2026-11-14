import { expect, test } from "bun:test";
import {
  connectionInputSchema,
  connectionTestRequestSchema,
  parseTargetId,
} from "./connections.ts";

const valid = {
  label: "Prod",
  engine: "postgres",
  host: "db.example.com",
  port: 5432,
  username: "app",
  tls: { mode: "require", ca: null },
};
const CERT = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";

test("accepts a minimal connection", () => {
  expect(connectionInputSchema.safeParse(valid).success).toBe(true);
});

test.each(["http://x", "db host", ""])("rejects host %p", (host) => {
  expect(connectionInputSchema.safeParse({ ...valid, host }).success).toBe(false);
});

test("accepts an IPv6 host", () => {
  expect(connectionInputSchema.safeParse({ ...valid, host: "::1" }).success).toBe(true);
});

test("rejects a CA without verify mode", () => {
  const tls = { mode: "require", ca: CERT };
  expect(connectionInputSchema.safeParse({ ...valid, tls }).success).toBe(false);
});

test("accepts a CA with verify mode", () => {
  const tls = { mode: "verify", ca: CERT };
  expect(connectionInputSchema.safeParse({ ...valid, tls }).success).toBe(true);
});

test("rejects a CA that isn't a certificate", () => {
  const tls = { mode: "verify", ca: "hello" };
  expect(connectionInputSchema.safeParse({ ...valid, tls }).success).toBe(false);
});

test("rejects unknown keys", () => {
  expect(connectionInputSchema.safeParse({ ...valid, id: "x" }).success).toBe(false);
});

test("trims the label", () => {
  const parsed = connectionInputSchema.parse({ ...valid, label: "  Prod  " });
  expect(parsed.label).toBe("Prod");
});

test("test request accepts a saved id with changes", () => {
  const request = { id: "0b7a3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d", host: "h" };
  expect(connectionTestRequestSchema.safeParse(request).success).toBe(true);
});

test("test request accepts a full input", () => {
  expect(connectionTestRequestSchema.safeParse(valid).success).toBe(true);
});

test.each([
  ["s.orders", { kind: "server", name: "orders" }],
  [
    "c.0b7a3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d",
    { kind: "connection", id: "0b7a3c1e-1d2f-4a5b-8c9d-0e1f2a3b4c5d" },
  ],
  ["x.orders", null],
  ["s.Orders", null],
  ["c.nope", null],
] as const)("parseTargetId(%p)", (id, expected) => {
  expect(parseTargetId(id)).toEqual(expected);
});
