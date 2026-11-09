import type { DockerStatus } from "@dpilot/shared";
import { type AppDeps, createApp } from "../app.ts";
import { sessionCookieName } from "../auth/session.ts";
import { createInstanceService } from "../instances/service.ts";
import { FakeEngineApi } from "./fake-engine-api.ts";

export const TEST_TOKEN = "c".repeat(64);
export const TEST_HOST = "127.0.0.1:7311";

export const authedHeaders = {
  host: TEST_HOST,
  cookie: `${sessionCookieName(TEST_HOST)}=${TEST_TOKEN}`,
};

export const runningDocker: DockerStatus = {
  state: "running",
  endpoint: "npipe:////./pipe/docker_engine",
  version: "27.3.1",
  apiVersion: "1.47",
  os: "linux",
  arch: "amd64",
};

/** App wired to an in-memory Docker engine; override any dependency per test. */
export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  const engine = new FakeEngineApi();
  const deps: AppDeps = {
    token: TEST_TOKEN,
    version: "0.1.0",
    startedAt: 1_000,
    now: () => 61_500,
    docker: { status: async () => runningDocker },
    instances: createInstanceService({
      docker: engine,
      isPortFree: async () => true,
      generatePassword: () => "generated-pw",
    }),
    versions: {
      versions: async (engine) => ({ engine, versions: ["2.0", "1.0"], source: "fallback" }),
    },
    staticFiles: null,
    ...overrides,
  };
  return { app: createApp(deps), engine, deps };
}
