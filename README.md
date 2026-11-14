# Dpilot

Create and manage local databases with Docker, from one web app.

Dpilot is a single binary. Run it, and it opens a browser tab where you can start database
containers (MySQL, MariaDB, PostgreSQL and more) and work with their schemas and data. See
[docs/PLAN.md](docs/PLAN.md) for the roadmap.

> Status: milestone M1. Dpilot creates, starts, stops and removes MySQL, MariaDB and PostgreSQL
> containers. Schema and data tools arrive in later milestones.

## What you can do

- Pick an engine and a version (listed from Docker Hub, with a built-in fallback) and create a
  database server. Dpilot downloads the image, creates a data volume and starts the container,
  and shows progress until the server accepts connections.
- Optionally name a first database, which the server creates on first start. Database names use
  lowercase letters, digits and underscores. The engine's own system databases, such as
  `postgres` or `mysql`, are always there too.
- Copy the host, port, user, password, database or a connection URL.
- Start, stop, restart or remove a server. Removing keeps its data volume unless you choose to
  delete it.
- Watch CPU and memory use, and read the latest log lines.
- Download a Docker Compose file that runs the same server without Dpilot.

Dpilot names its containers `dpilot-<name>` and volumes `dpilot_<name>_data`, and labels them
`dpilot.managed=true`. It only lists and changes containers with that label.

## Requirements

- [Bun](https://bun.sh) 1.4.4 or later
- Docker Desktop, or Docker Engine on Linux

## Develop

```sh
bun install
bun run dev
```

`bun run dev` starts the API server on port 7311 (restarts on change) and the Vite dev server on
port 5173, and prints a sign-in link. Open that link. In dev mode the token is stored in
`apps/server/.dev-token`, so the link keeps working across server restarts. Press Ctrl+C to stop
both servers.

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `bun test`          | Run all tests                                                        |
| `bun run typecheck` | Type-check every workspace                                           |
| `bun run lint`      | Check formatting and lint rules (Biome)                              |
| `bun run format`    | Apply formatting and safe lint fixes                                 |
| `bun run build`     | Build the web UI into `apps/web/dist`                                |
| `bun run compile`   | Build the web UI and compile `dist/dpilot` (`dpilot.exe` on Windows) |

## Run the binary

```sh
dpilot              # serves on 127.0.0.1:7311, or the next free port, and opens the browser
dpilot --port 8000  # use a specific port
dpilot --no-open    # print the link without opening a browser
dpilot --help
```

## Layout

```
apps/server     Hono API, Docker Engine API client, instance service, CLI and binary entry
apps/web        React + Vite UI
packages/shared Types shared by server and web
```

## Security

Dpilot can start containers and run SQL, so it only accepts requests from your own machine:

- The server listens on `127.0.0.1` only.
- Each run creates a random 256-bit token. The printed link exchanges it for an `HttpOnly`,
  `SameSite=Strict` session cookie and then removes it from the address bar.
- Requests must use a loopback `Host` (blocks DNS rebinding), and state-changing requests must
  come from a loopback `Origin` (blocks cross-site requests).
- Database ports are published on `127.0.0.1` only, so other machines can't reach them.
- Database passwords live in the container's environment, as the official images expect. Anyone
  who can run `docker inspect` on this machine can read them; use Dpilot for local development
  data only.
- Errors returned to the browser never include internal details. Docker's own error messages
  are passed through so you can act on them.
