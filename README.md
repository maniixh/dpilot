# Dpilot

Create and manage local databases with Docker, from one web app.

Dpilot is a single binary. Run it, and it opens a browser tab where you can start database
containers (MySQL, MariaDB, PostgreSQL and more) and work with their schemas and data. See
[docs/PLAN.md](docs/PLAN.md) for the roadmap.

> Status: milestone M0. The app starts, authenticates the browser and checks Docker. Database
> features arrive in later milestones.

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
`apps/server/.dev-token`, so the link keeps working across server restarts.

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
apps/server     Hono API, Docker client, CLI and the compiled-binary entry
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
- Errors returned to the browser never include internal details.
