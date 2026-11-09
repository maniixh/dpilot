# M1: Docker instances

Spec: [docs/PLAN.md](../PLAN.md) sections 5.2, 5.3, 6, 7 and milestone M1.

Done when: a MySQL and a Postgres instance can be created from the UI and reach "ready".

## Scope decisions

- Engines: MySQL, MariaDB, PostgreSQL. MongoDB and Redis provisioning moves to M8 with their adapters.
- No local store yet (M2). An instance is a Docker container labelled `dpilot.managed=true`;
  name, engine, version and host port live in labels; credentials are read back from the
  container's environment.
- Readiness uses a Docker `HEALTHCHECK` per engine (`mysqladmin ping`, `healthcheck.sh`,
  `pg_isready`) over TCP so the init-time server does not count. A driver-level probe comes in M2.
- Creation runs as an in-memory job (pull, create, start); the UI polls. WebSockets come later.
- Logs are a tail, stats are a one-shot sample; both polled by the UI.
- Existing data volume with the requested name: refuse (409) instead of silently reusing data
  whose password would not match.

## Interfaces

- `packages/shared`: `ENGINES`, `EngineId`, `createInstanceRequestSchema`, `InstanceSummary`,
  `InstanceDetail`, `InstanceState`, `InstanceStats`, `EngineVersions`.
- `apps/server/src/docker/connection.ts`: `DockerConnection { status(); request(opts) }`.
- `apps/server/src/docker/engine-api.ts`: typed Engine API calls over `request`.
- `apps/server/src/instances/service.ts`: `InstanceService` used by routes.
- Routes per PLAN section 6: `/catalog/engines`, `/catalog/engines/:id/versions`, `/instances`,
  `/instances/:name`, `start|stop|restart`, `DELETE ?removeVolume=`, `logs`, `stats`, `compose`.

## Tasks

1. Shared catalog and instance contracts (schemas, types).
2. Docker connection: generic request (method, JSON body, streaming, idle timeout), endpoint
   caching; `status()` keeps its behaviour.
3. Engine API: images, volumes, containers, logs (stream demux), stats (CPU/memory maths),
   pull progress aggregation.
4. Version source: Docker Hub tags, stable semver filter, 1 h cache, fallback list.
5. Engine Docker specs (env, healthcheck, data path incl. Postgres 18+) and compose export.
6. Instance service: list/detail mapping, create job, port allocation, lifecycle, remove.
7. Routes, app and CLI wiring.
8. Web: routing, instance list, create form, instance page (connection, actions, stats, logs,
   compose).
9. Verification against real Docker (MySQL and Postgres reach ready), README.
