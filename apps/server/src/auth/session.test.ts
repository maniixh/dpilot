import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireSession, sessionCookieName, sessionRoutes } from "./session.ts";

const token = "a".repeat(64);
const otherToken = "b".repeat(64);
const host = "127.0.0.1:7311";
const cookieName = sessionCookieName(host);

const app = new Hono()
  .route("/session", sessionRoutes(token))
  .use("/private/*", requireSession(token))
  .get("/private/data", (c) => c.json({ secret: true }));

function getPrivate(headers: Record<string, string>) {
  return app.request("/private/data", { headers: { host, ...headers } });
}

function postSession(body: unknown) {
  return app.request("/session", {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("sessionCookieName", () => {
  test("is scoped to the port, because browsers share cookies across ports", () => {
    expect(sessionCookieName("127.0.0.1:7311")).toBe("dpilot_session_7311");
    expect(sessionCookieName("localhost:5173")).toBe("dpilot_session_5173");
  });

  test("uses port 80 when Host has no port", () => {
    expect(sessionCookieName("localhost")).toBe("dpilot_session_80");
  });
});

describe("requireSession", () => {
  test("rejects a request without the session cookie", async () => {
    expect((await getPrivate({})).status).toBe(401);
  });

  test("rejects a request with the wrong session cookie", async () => {
    expect((await getPrivate({ cookie: `${cookieName}=${otherToken}` })).status).toBe(401);
  });

  test("ignores a session cookie issued for another port", async () => {
    const res = await getPrivate({ cookie: `${sessionCookieName("127.0.0.1:7312")}=${token}` });
    expect(res.status).toBe(401);
  });

  test("allows a request with the matching session cookie", async () => {
    expect((await getPrivate({ cookie: `${cookieName}=${token}` })).status).toBe(200);
  });
});

describe("POST /session", () => {
  test("sets an HttpOnly SameSite=Strict cookie for the correct token", async () => {
    const res = await postSession({ token });

    expect(res.status).toBe(204);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${cookieName}=${token}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
  });

  test("rejects a wrong token without setting a cookie", async () => {
    const res = await postSession({ token: otherToken });

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("rejects a malformed token with 400", async () => {
    expect((await postSession({ token: "short" })).status).toBe(400);
  });
});
