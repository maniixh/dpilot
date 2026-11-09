import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { localRequestGuard } from "./local-request.ts";

const app = new Hono()
  .use(localRequestGuard())
  .get("/ping", (c) => c.text("pong"))
  .post("/ping", (c) => c.text("pong"));

function send(method: "GET" | "POST", headers: Record<string, string>) {
  return app.request("http://placeholder/ping", { method, headers });
}

describe("localRequestGuard", () => {
  test.each(["127.0.0.1:7311", "localhost:5173", "[::1]:7311", "localhost"])(
    "allows GET with loopback Host %s",
    async (host) => {
      expect((await send("GET", { host })).status).toBe(200);
    },
  );

  test("rejects a non-loopback Host to block DNS rebinding", async () => {
    expect((await send("GET", { host: "evil.example:7311" })).status).toBe(403);
  });

  test("rejects a request without a Host header", async () => {
    expect((await send("GET", {})).status).toBe(403);
  });

  test("rejects a cross-site Origin even on GET", async () => {
    const res = await send("GET", { host: "127.0.0.1:7311", origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  test("rejects POST without an Origin header", async () => {
    expect((await send("POST", { host: "127.0.0.1:7311" })).status).toBe(403);
  });

  test("allows POST from a loopback Origin", async () => {
    const res = await send("POST", { host: "localhost:5173", origin: "http://localhost:5173" });
    expect(res.status).toBe(200);
  });

  test("rejects POST from a page on another loopback port", async () => {
    const res = await send("POST", { host: "127.0.0.1:7311", origin: "http://127.0.0.1:8000" });
    expect(res.status).toBe(403);
  });

  test("rejects an Origin naming a different loopback host than Host", async () => {
    const res = await send("POST", { host: "127.0.0.1:7311", origin: "http://localhost:7311" });
    expect(res.status).toBe(403);
  });

  test("rejects an Origin that only starts with localhost", async () => {
    const res = await send("POST", {
      host: "127.0.0.1:7311",
      origin: "http://localhost.evil.example",
    });
    expect(res.status).toBe(403);
  });
});
