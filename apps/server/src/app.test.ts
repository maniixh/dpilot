import { describe, expect, test } from "bun:test";
import type { DockerStatus } from "@dpilot/shared";
import { type AppDeps, createApp } from "./app.ts";
import { sessionCookieName } from "./auth/session.ts";

const token = "c".repeat(64);
const runningDocker: DockerStatus = {
  state: "running",
  endpoint: "npipe:////./pipe/docker_engine",
  version: "27.3.1",
  apiVersion: "1.47",
  os: "linux",
  arch: "amd64",
};

function buildApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    token,
    version: "0.1.0",
    startedAt: 1_000,
    now: () => 61_500,
    docker: { status: async () => runningDocker },
    staticFiles: null,
    ...overrides,
  });
}

const authed = {
  host: "127.0.0.1:7311",
  cookie: `${sessionCookieName("127.0.0.1:7311")}=${token}`,
};

describe("createApp", () => {
  test("requires a session for API routes", async () => {
    const res = await buildApp().request("/api/health", { headers: { host: "127.0.0.1:7311" } });
    expect(res.status).toBe(401);
  });

  test("rejects requests to a non-loopback host before auth", async () => {
    const res = await buildApp().request("/api/health", {
      headers: { ...authed, host: "rebind.example" },
    });
    expect(res.status).toBe(403);
  });

  test("GET /api/health reports version and whole-second uptime", async () => {
    const res = await buildApp().request("/api/health", { headers: authed });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.1.0", uptimeSeconds: 60 });
  });

  test("GET /api/docker/status returns the Docker client's status", async () => {
    const res = await buildApp().request("/api/docker/status", { headers: authed });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(runningDocker);
  });

  test("unknown API routes return a JSON 404", async () => {
    const res = await buildApp().request("/api/nope", { headers: authed });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("serves the web UI without a session when static files are enabled", async () => {
    const app = buildApp({ staticFiles: (c) => c.html("<p>ui</p>") });

    const res = await app.request("/tables/users", { headers: { host: "127.0.0.1:7311" } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>ui</p>");
  });

  test("keeps unknown API routes as JSON 404 when static files are enabled", async () => {
    const app = buildApp({ staticFiles: (c) => c.html("<p>ui</p>") });

    const res = await app.request("/api/nope", { headers: authed });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  test("unexpected errors return a generic 500 without leaking details", async () => {
    const app = buildApp({
      docker: {
        status: async () => {
          throw new Error("secret internal detail");
        },
      },
    });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await app.request("/api/docker/status", { headers: authed });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("secret internal detail");
    } finally {
      console.error = originalError;
    }
  });
});
