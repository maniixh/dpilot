import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerEndpoint } from "../docker/endpoint.ts";

export interface FakeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export type FakeResponse =
  | { status: number; body: string; contentType?: string; delayMs?: number }
  /** Sent without Content-Length, closing the connection when done. */
  | {
      status: number;
      chunks: { data: string | Uint8Array; delayMs?: number }[];
      stallAfter?: boolean;
    };

/** Returns null to leave the request hanging. */
export type FakeHandler = (request: FakeRequest) => FakeResponse | null;

export interface FakeEngine {
  endpoint: DockerEndpoint;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const running = new Set<FakeEngine>();

/** Closes every fake engine still open; use in afterEach. */
export async function closeFakeEngines(): Promise<void> {
  await Promise.all([...running].map((engine) => engine.close()));
}

export function uniqueSocketPath(): string {
  const id = `dpilot-test-${process.pid}-${crypto.randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : join(tmpdir(), `${id}.sock`);
}

export function missingEndpoint(): DockerEndpoint {
  const socketPath = uniqueSocketPath();
  return { transport: "socket", socketPath, label: `missing://${socketPath}` };
}

export function json(status: number, value: unknown): FakeResponse {
  return { status, body: JSON.stringify(value) };
}

/**
 * Minimal HTTP/1.1 responder on a named pipe (Windows) or unix socket, like the Docker daemon.
 * Uses node:net because Bun's node:http server cannot listen on Windows named pipes.
 */
export async function startFakeEngine(handler: FakeHandler): Promise<FakeEngine> {
  const socketPath = uniqueSocketPath();
  const sockets = new Set<Socket>();
  const requests: FakeRequest[] = [];

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const request = parseRequest(buffered);
      if (!request) return;
      socket.off("data", onData);
      requests.push(request);
      const response = handler(request);
      if (response) void respond(socket, response);
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const engine: FakeEngine = {
    endpoint: { transport: "socket", socketPath, label: `fake://${socketPath}` },
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        running.delete(engine);
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  running.add(engine);
  return engine;
}

function parseRequest(data: Buffer): FakeRequest | null {
  const headerEnd = data.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;
  const [requestLine = "", ...headerLines] = data
    .subarray(0, headerEnd)
    .toString("latin1")
    .split("\r\n");
  const [method = "", path = ""] = requestLine.split(" ");
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const length = Number(headers["content-length"] ?? 0);
  const bodyStart = headerEnd + 4;
  if (data.length < bodyStart + length) return null;
  const body = data.subarray(bodyStart, bodyStart + length).toString("utf8");
  return { method, path, headers, body };
}

async function respond(socket: Socket, response: FakeResponse): Promise<void> {
  if ("body" in response) {
    if (response.delayMs) await Bun.sleep(response.delayMs);
    if (socket.destroyed) return;
    socket.end(
      `HTTP/1.1 ${response.status} X\r\nContent-Type: ${response.contentType ?? "application/json"}\r\n` +
        `Content-Length: ${Buffer.byteLength(response.body)}\r\nConnection: close\r\n\r\n${response.body}`,
    );
    return;
  }
  socket.write(
    `HTTP/1.1 ${response.status} X\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n`,
  );
  for (const chunk of response.chunks) {
    if (chunk.delayMs) await Bun.sleep(chunk.delayMs);
    if (socket.destroyed) return;
    socket.write(chunk.data);
  }
  if (!response.stallAfter) socket.end();
}
