import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerClient } from "./client.ts";
import { type DockerEndpoint, UnsupportedDockerHostError } from "./endpoint.ts";

interface FakeResponse {
  status: number;
  body: string;
}

/** Returns null to leave the request hanging. */
type FakeHandler = (request: { method: string; path: string }) => FakeResponse | null;

const servers: { server: Server; sockets: Set<Socket> }[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      ({ server, sockets }) =>
        new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        }),
    ),
  );
});

function uniqueSocketPath(): string {
  const id = `dpilot-test-${process.pid}-${crypto.randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

/**
 * Minimal HTTP/1.1 responder on a named pipe (Windows) or unix socket, like the Docker daemon.
 * Uses node:net because Bun's node:http server cannot listen on Windows named pipes.
 */
async function startFakeEngine(handler: FakeHandler): Promise<DockerEndpoint> {
  const socketPath = uniqueSocketPath();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => {
      const [method = "", path = ""] =
        chunk.toString("latin1").split("\r\n", 1)[0]?.split(" ") ?? [];
      const response = handler({ method, path });
      if (!response) return;
      socket.end(
        `HTTP/1.1 ${response.status} X\r\nContent-Type: application/json\r\n` +
          `Content-Length: ${Buffer.byteLength(response.body)}\r\nConnection: close\r\n\r\n${response.body}`,
      );
    });
  });
  servers.push({ server, sockets });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { transport: "socket", socketPath, label: `fake://${socketPath}` };
}

function missingEndpoint(): DockerEndpoint {
  const socketPath = uniqueSocketPath();
  return { transport: "socket", socketPath, label: `missing://${socketPath}` };
}

const versionBody = { Version: "27.3.1", ApiVersion: "1.47", Os: "linux", Arch: "amd64" };

function respondWithVersion(): FakeHandler {
  return ({ method, path }) =>
    method === "GET" && path === "/version"
      ? { status: 200, body: JSON.stringify(versionBody) }
      : { status: 404, body: "" };
}

describe("createDockerClient().status", () => {
  test("reports the engine version from GET /version over a socket", async () => {
    const endpoint = await startFakeEngine(respondWithVersion());
    const client = createDockerClient({ resolveEndpoints: () => [endpoint], timeoutMs: 2000 });

    expect(await client.status()).toEqual({
      state: "running",
      endpoint: endpoint.label,
      version: "27.3.1",
      apiVersion: "1.47",
      os: "linux",
      arch: "amd64",
    });
  });

  test("falls through to the next endpoint when the first is unreachable", async () => {
    const missing = missingEndpoint();
    const live = await startFakeEngine(respondWithVersion());
    const client = createDockerClient({
      resolveEndpoints: () => [missing, live],
      timeoutMs: 2000,
    });

    const status = await client.status();

    expect(status.state).toBe("running");
    expect(status.state === "running" && status.endpoint).toBe(live.label);
  });

  test("reports every tried endpoint when none respond", async () => {
    const first = missingEndpoint();
    const second = missingEndpoint();
    const client = createDockerClient({
      resolveEndpoints: () => [first, second],
      timeoutMs: 2000,
    });

    const status = await client.status();

    expect(status.state).toBe("unreachable");
    expect(status.state === "unreachable" && status.triedEndpoints).toEqual([
      first.label,
      second.label,
    ]);
  });

  test("treats a non-2xx response as unreachable", async () => {
    const endpoint = await startFakeEngine(() => ({ status: 500, body: "boom" }));
    const client = createDockerClient({ resolveEndpoints: () => [endpoint], timeoutMs: 2000 });

    const status = await client.status();

    expect(status.state).toBe("unreachable");
    expect(status.state === "unreachable" && status.reason).toContain("500");
  });

  test("treats a malformed /version body as unreachable", async () => {
    const endpoint = await startFakeEngine(() => ({
      status: 200,
      body: JSON.stringify({ hello: "world" }),
    }));
    const client = createDockerClient({ resolveEndpoints: () => [endpoint], timeoutMs: 2000 });

    expect((await client.status()).state).toBe("unreachable");
  });

  test("gives up on an engine that never answers after the timeout", async () => {
    const endpoint = await startFakeEngine(() => null);
    const client = createDockerClient({ resolveEndpoints: () => [endpoint], timeoutMs: 150 });

    const started = performance.now();
    const status = await client.status();

    expect(status.state).toBe("unreachable");
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("reports an unsupported DOCKER_HOST as unreachable with its reason", async () => {
    const client = createDockerClient({
      resolveEndpoints: () => {
        throw new UnsupportedDockerHostError("Unsupported DOCKER_HOST scheme: ssh://x");
      },
      timeoutMs: 2000,
    });

    expect(await client.status()).toEqual({
      state: "unreachable",
      triedEndpoints: [],
      reason: "Unsupported DOCKER_HOST scheme: ssh://x",
    });
  });
});
