import { type EngineId, getEngine, type InstanceConnection } from "@dpilot/shared";
import type { ContainerCreateSpec } from "../docker/engine-api.ts";

export const MANAGED_LABEL = "dpilot.managed";
export const LABEL = {
  managed: MANAGED_LABEL,
  instance: "dpilot.instance",
  engine: "dpilot.engine",
  version: "dpilot.version",
  port: "dpilot.port",
} as const;

export const BIND_HOST = "127.0.0.1";

export interface InstanceIdentity {
  name: string;
  engine: EngineId;
  version: string;
  port: number;
}

export interface InstanceSettings extends InstanceIdentity {
  password: string;
}

export interface EngineDockerSpec {
  containerPort: number;
  env(password: string): string[];
  passwordFromEnv(env: Record<string, string>): string | null;
  /** Docker HEALTHCHECK test; checks over TCP so the init-time server does not count as ready. */
  healthcheck: string[];
  dataPath(version: string): string;
}

const SPECS: Record<EngineId, EngineDockerSpec> = {
  mysql: {
    containerPort: 3306,
    env: (password) => [`MYSQL_ROOT_PASSWORD=${password}`],
    passwordFromEnv: (env) => env.MYSQL_ROOT_PASSWORD ?? null,
    healthcheck: [
      "CMD-SHELL",
      'mysqladmin ping -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --silent',
    ],
    dataPath: () => "/var/lib/mysql",
  },
  mariadb: {
    containerPort: 3306,
    env: (password) => [`MARIADB_ROOT_PASSWORD=${password}`],
    passwordFromEnv: (env) => env.MARIADB_ROOT_PASSWORD ?? null,
    healthcheck: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
    dataPath: () => "/var/lib/mysql",
  },
  postgres: {
    containerPort: 5432,
    env: (password) => ["POSTGRES_USER=postgres", `POSTGRES_PASSWORD=${password}`],
    passwordFromEnv: (env) => env.POSTGRES_PASSWORD ?? null,
    healthcheck: ["CMD-SHELL", "pg_isready -U postgres -h 127.0.0.1"],
    // The postgres 18+ images moved PGDATA under a versioned directory below /var/lib/postgresql.
    dataPath: (version) => {
      const major = Number.parseInt(version, 10);
      return Number.isNaN(major) || major >= 18
        ? "/var/lib/postgresql"
        : "/var/lib/postgresql/data";
    },
  },
};

const SECOND_NS = 1_000_000_000;
export const HEALTHCHECK_TIMING = {
  Interval: 3 * SECOND_NS,
  Timeout: 5 * SECOND_NS,
  Retries: 5,
  StartPeriod: 180 * SECOND_NS,
};

export function engineSpec(engine: EngineId): EngineDockerSpec {
  return SPECS[engine];
}

export function containerName(name: string): string {
  return `dpilot-${name}`;
}

export function volumeName(name: string): string {
  return `dpilot_${name}_data`;
}

export function imageRef(engine: EngineId, version: string): string {
  return `${getEngine(engine).image}:${version}`;
}

export function labelsFor(instance: InstanceIdentity): Record<string, string> {
  return {
    [LABEL.managed]: "true",
    [LABEL.instance]: instance.name,
    [LABEL.engine]: instance.engine,
    [LABEL.version]: instance.version,
    [LABEL.port]: String(instance.port),
  };
}

export function connectionFor(
  engine: EngineId,
  port: number,
  password: string,
): InstanceConnection {
  const user = getEngine(engine).defaultUser;
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  const url =
    engine === "postgres"
      ? `postgres://${auth}@${BIND_HOST}:${port}/postgres`
      : `mysql://${auth}@${BIND_HOST}:${port}`;
  return { host: BIND_HOST, port, user, password, url };
}

export function buildContainerSpec(settings: InstanceSettings): ContainerCreateSpec {
  const spec = engineSpec(settings.engine);
  const portKey = `${spec.containerPort}/tcp`;
  return {
    Image: imageRef(settings.engine, settings.version),
    Env: spec.env(settings.password),
    Labels: labelsFor(settings),
    ExposedPorts: { [portKey]: {} },
    Healthcheck: { Test: spec.healthcheck, ...HEALTHCHECK_TIMING },
    HostConfig: {
      PortBindings: { [portKey]: [{ HostIp: BIND_HOST, HostPort: String(settings.port) }] },
      Mounts: [
        {
          Type: "volume",
          Source: volumeName(settings.name),
          Target: spec.dataPath(settings.version),
        },
      ],
      RestartPolicy: { Name: "no" },
    },
  };
}
