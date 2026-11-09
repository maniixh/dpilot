import { afterEach, describe, expect, test } from "bun:test";
import {
  closeFakeEngines,
  type FakeHandler,
  missingEndpoint,
  startFakeEngine,
} from "../testing/fake-docker-engine.ts";
import { createDockerClient } from "./client.ts";
import { UnsupportedDockerHostError } from "./endpoint.ts";
import { DockerUnavailableError } from "./types.ts";

afterEach(closeFakeEngines);

const versionBody = { Version: "27.3.1", ApiVersion: "1.47", Os: "linux", Arch: "amd64" };

function respondWithVersion(): FakeHandler {
  return ({ method, path }) =>
    method === "GET" && path === "/version"
      ? { status: 200, body: JSON.stringify(versionBody) }
      : { status: 404, body: "" };
}

describe("createDockerClient().status", () => {
  test("reports the engine version from GET /version over a socket", async () => {
    const { endpoint } = await startFakeEngine(respondWithVersion());
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
    const { endpoint: live } = await startFakeEngine(respondWithVersion());
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
    const { endpoint } = await startFakeEngine(() => ({ status: 500, body: "boom" }));
    const client = createDockerClient({ resolveEndpoints: () => [endpoint], timeoutMs: 2000 });

    const status = await client.status();

    expect(status.state).toBe("unreachable");
    expect(status.state === "unreachable" && status.reason).toContain("500");
  });

  test("treats a malformed /version body as unreachable", async () => {
    const { endpoint } = await startFakeEngine(() => ({
      status: 200,
      body: JSON.stringify({ hello: "world" }),
    }));
    const client = createDockerClient({ resolveEndpoints: () => [endpoint], timeoutMs: 2000 });

    expect((await client.status()).state).toBe("unreachable");
  });

  test("gives up on an engine that never answers after the timeout", async () => {
    const { endpoint } = await startFakeEngine(() => null);
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

describe("createDockerClient().request", () => {
  function versionThen(handler: FakeHandler): FakeHandler {
    return (req) =>
      req.path === "/version" ? { status: 200, body: JSON.stringify(versionBody) } : handler(req);
  }

  test("discovers a working endpoint once and reuses it", async () => {
    const engine = await startFakeEngine(versionThen(() => ({ status: 200, body: "[]" })));
    const client = createDockerClient({
      resolveEndpoints: () => [missingEndpoint(), engine.endpoint],
      timeoutMs: 2000,
    });

    const first = await client.request({ method: "GET", path: "/containers/json" });
    await client.request({ method: "GET", path: "/containers/json" });

    expect(first.status).toBe(200);
    expect(engine.requests.map((r) => r.path)).toEqual([
      "/version",
      "/containers/json",
      "/containers/json",
    ]);
  });

  test("throws DockerUnavailableError with the reason when no endpoint answers", async () => {
    const client = createDockerClient({
      resolveEndpoints: () => [missingEndpoint()],
      timeoutMs: 2000,
    });

    const promise = client.request({ method: "GET", path: "/containers/json" });

    await expect(promise).rejects.toBeInstanceOf(DockerUnavailableError);
  });

  test("forgets a dead endpoint and rediscovers on the next call", async () => {
    const first = await startFakeEngine(versionThen(() => ({ status: 200, body: "[]" })));
    let endpoints = [first.endpoint];
    const client = createDockerClient({ resolveEndpoints: () => endpoints, timeoutMs: 2000 });
    await client.request({ method: "GET", path: "/a" });

    await first.close();
    await expect(client.request({ method: "GET", path: "/b" })).rejects.toBeInstanceOf(
      DockerUnavailableError,
    );

    const second = await startFakeEngine(versionThen(() => ({ status: 204, body: "" })));
    endpoints = [second.endpoint];
    const res = await client.request({ method: "POST", path: "/c" });
    expect(res.status).toBe(204);
  });

  test("status() also primes the endpoint used by request()", async () => {
    const engine = await startFakeEngine(versionThen(() => ({ status: 200, body: "{}" })));
    const client = createDockerClient({
      resolveEndpoints: () => [engine.endpoint],
      timeoutMs: 2000,
    });

    await client.status();
    await client.request({ method: "GET", path: "/x" });

    expect(engine.requests.map((r) => r.path)).toEqual(["/version", "/x"]);
  });
});
