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
- Save connections to other MySQL, MariaDB or PostgreSQL servers, with optional TLS (require, or
  verify against a pasted CA certificate). Test a connection before saving it.
- Browse every server in the sidebar: Dpilot servers and saved connections, then databases,
  schemas (PostgreSQL), tables, views, procedures and functions.
- Open a server to see its version, user, uptime, charset and time zone, and search its
  variables. Open a database to see what it contains.
- Browse a table's rows in a virtualised grid with sorting, filters and search. Edit cells, insert
  and delete rows, and see BLOB values safely. Tables without a primary key are read-only.
- Write SQL in the editor, with syntax highlighting and completion from the database's schema.
  Run the statement at the cursor (Ctrl/Cmd+Enter) or everything (Ctrl/Cmd+Shift+Enter), and
  cancel a run with Esc. Each statement gets its own result: rows, an affected count, or the
  error with its position. Results are capped at 10,000 rows, and a run shows at most its first
  50 and last 50 outcomes. Destructive statements ask for confirmation first.
- Keep up to 10 editor tabs, search the query history, save named queries, and run a `.sql` file
  of up to 16 MB.

A connection marked read-only makes Dpilot refuse statements that change data. This is a guard
rail, not a security boundary. For real protection, connect with a database user that only has
`SELECT` privileges.

Saved connections live in `~/.dpilot/dpilot.db`. Their passwords are encrypted with a key in
`~/.dpilot/key`. Both files are readable by your user only (on Windows, through your user
profile's permissions). If the key is lost, Dpilot keeps the connections but asks for each
password again.

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
| `DPILOT_INTEGRATION=1 bun test apps/server/src/engines/integration.test.ts` | Run the engine adapters against real database containers (needs Docker) |
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
