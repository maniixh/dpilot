import type { DockerStatus } from "@dpilot/shared";
import { type AppDeps, createApp } from "../app.ts";
import { sessionCookieName } from "../auth/session.ts";
import { createConnectionService } from "../connections/service.ts";
import { createExplorer } from "../explorer/service.ts";
import type { Explorer } from "../explorer/types.ts";
import { createInstanceService } from "../instances/service.ts";
import { openStore } from "../store/database.ts";
import type { KeyStore } from "../store/types.ts";
import { FakeEngineApi } from "./fake-engine-api.ts";
import { FakeSqlFactory } from "./fake-sql.ts";

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

function memoryKeyStore(): KeyStore {
  let key: Uint8Array | null = null;
  return {
    read: () => key,
    create: () => {
      key = crypto.getRandomValues(new Uint8Array(32));
      return key;
    },
  };
}

/** App wired to an in-memory Docker engine and SQL fake; override any dependency per test. */
export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  const engine = new FakeEngineApi();
  const sql = new FakeSqlFactory();
  const instances = createInstanceService({
    docker: engine,
    isPortFree: async () => true,
    generatePassword: () => "generated-pw",
  });
  let ids = 0;
  const connections = createConnectionService({
    db: openStore(":memory:"),
    keys: memoryKeyStore(),
    now: () => new Date("2026-11-15T00:00:00Z"),
    randomId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
    onChanged: (id) => void explorer.forget(`c.${id}`),
  });
  const explorer: Explorer = createExplorer({ instances, connections, sql: sql.factory });
  const deps: AppDeps = {
    token: TEST_TOKEN,
    version: "0.1.0",
    startedAt: 1_000,
    now: () => 61_500,
    docker: { status: async () => runningDocker },
    instances,
    versions: {
      versions: async (engine) => ({ engine, versions: ["2.0", "1.0"], source: "fallback" }),
    },
    connections,
    explorer,
    staticFiles: null,
    ...overrides,
  };
  return { app: createApp(deps), engine, sql, deps };
}
