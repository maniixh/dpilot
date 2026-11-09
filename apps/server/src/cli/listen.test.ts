import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { PortInUseError, startServer } from "./listen.ts";

const started: Server<undefined>[] = [];
afterEach(() => {
  for (const server of started.splice(0)) server.stop(true);
});

const fetch = () => new Response("ok");

function occupyRandomPort(): number {
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  started.push(blocker);
  return blocker.port ?? 0;
}

describe("startServer", () => {
  test("binds to 127.0.0.1 only", () => {
    const server = startServer({ port: 0, allowFallback: false, fetch });
    started.push(server);

    expect(server.hostname).toBe("127.0.0.1");
  });

  test("moves to a later port when the requested one is busy and fallback is allowed", () => {
    const busy = occupyRandomPort();

    const server = startServer({ port: busy, allowFallback: true, fetch });
    started.push(server);

    expect(server.port).toBeGreaterThan(busy);
  });

  test("fails with PortInUseError when the requested port is busy and pinned", () => {
    const busy = occupyRandomPort();

    expect(() => startServer({ port: busy, allowFallback: false, fetch })).toThrow(PortInUseError);
  });
});
