import { expect, test } from "bun:test";
import { authedHeaders, buildTestApp } from "../testing/build-app.ts";
import { driverError } from "../testing/fake-sql.ts";

const jsonHeaders = {
  ...authedHeaders,
  origin: `http://${authedHeaders.host}`,
  "content-type": "application/json",
};

const input = {
  label: "Prod",
  engine: "mysql",
  host: "db.example.com",
  port: 3306,
  username: "app",
  password: "s3cret",
  tls: { mode: "off", ca: null },
};

function setup() {
  const ctx = buildTestApp();
  const call = (method: string, path: string, body?: unknown) =>
    ctx.app.request(`/api${path}`, {
      method,
      headers: method === "GET" ? authedHeaders : jsonHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...ctx, call };
}

test("creates, reads, updates and deletes a connection", async () => {
  const { call } = setup();
  const created = await call("POST", "/connections", input);
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  expect((await call("GET", `/connections/${id}`)).status).toBe(200);
  const patched = await call("PATCH", `/connections/${id}`, { label: "Renamed" });
  expect(patched.status).toBe(200);
  expect(await patched.json()).toMatchObject({ label: "Renamed" });
  expect((await call("DELETE", `/connections/${id}`)).status).toBe(204);
  const gone = await call("GET", `/connections/${id}`);
  expect(gone.status).toBe(404);
  expect(await gone.json()).toMatchObject({ error: "not_found" });
});

test("never returns the password", async () => {
  const { call } = setup();
  await call("POST", "/connections", input);
  const text = await (await call("GET", "/connections")).text();
  expect(text).toContain("Prod");
  expect(text).not.toContain("s3cret");
});

test("rejects an invalid body", async () => {
  const res = await setup().call("POST", "/connections", { ...input, port: 0 });
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    error: "invalid_request",
    issues: { port: expect.any(Array) },
  });
});

test("rejects a duplicate label", async () => {
  const { call } = setup();
  await call("POST", "/connections", input);
  const res = await call("POST", "/connections", input);
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ error: "label_taken" });
});

test("asks for the password when the host changes", async () => {
  const { call } = setup();
  const { id } = (await (await call("POST", "/connections", input)).json()) as { id: string };
  const patch = await call("PATCH", `/connections/${id}`, { host: "other.example.com" });
  expect(patch.status).toBe(400);
  expect(await patch.json()).toMatchObject({ error: "password_required" });
  const tested = await call("POST", "/connections/test", { id, host: "other.example.com" });
  expect(tested.status).toBe(400);
});

test("reports a failed test as ok false", async () => {
  const { call, sql } = setup();
  sql.respond(/VERSION/, driverError({ errno: 1045 }));
  const res = await call("POST", "/connections/test", input);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: false, code: "auth_failed" });
});

test("reports a successful test with server info", async () => {
  const { call, sql } = setup();
  sql.respond(/VERSION/, [{ version: "8.4.3", user: "app@%", charset: null, timeZone: null }]);
  const res = await call("POST", "/connections/test", input);
  expect(await res.json()).toMatchObject({ ok: true, info: { engine: "mysql", version: "8.4.3" } });
});
