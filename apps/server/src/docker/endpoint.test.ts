import { describe, expect, test } from "bun:test";
import { resolveDockerEndpoints, UnsupportedDockerHostError } from "./endpoint.ts";

const base = { homeDir: "/home/dev" };

describe("resolveDockerEndpoints", () => {
  test("uses a unix DOCKER_HOST as the only candidate", () => {
    const endpoints = resolveDockerEndpoints({
      ...base,
      platform: "linux",
      env: { DOCKER_HOST: "unix:///run/user/1000/docker.sock" },
    });
    expect(endpoints).toEqual([
      {
        transport: "socket",
        socketPath: "/run/user/1000/docker.sock",
        label: "unix:///run/user/1000/docker.sock",
      },
    ]);
  });

  test("converts an npipe DOCKER_HOST to a Windows pipe path", () => {
    const endpoints = resolveDockerEndpoints({
      ...base,
      platform: "win32",
      env: { DOCKER_HOST: "npipe:////./pipe/docker_engine" },
    });
    expect(endpoints).toEqual([
      {
        transport: "socket",
        socketPath: "\\\\.\\pipe\\docker_engine",
        label: "npipe:////./pipe/docker_engine",
      },
    ]);
  });

  test("converts a tcp DOCKER_HOST to an http base url", () => {
    const endpoints = resolveDockerEndpoints({
      ...base,
      platform: "linux",
      env: { DOCKER_HOST: "tcp://127.0.0.1:2375" },
    });
    expect(endpoints).toEqual([
      { transport: "tcp", baseUrl: "http://127.0.0.1:2375", label: "tcp://127.0.0.1:2375" },
    ]);
  });

  test("rejects tcp with TLS verification because TLS is not supported yet", () => {
    expect(() =>
      resolveDockerEndpoints({
        ...base,
        platform: "linux",
        env: { DOCKER_HOST: "tcp://10.0.0.5:2376", DOCKER_TLS_VERIFY: "1" },
      }),
    ).toThrow(UnsupportedDockerHostError);
  });

  test("rejects unsupported schemes such as ssh", () => {
    expect(() =>
      resolveDockerEndpoints({
        ...base,
        platform: "linux",
        env: { DOCKER_HOST: "ssh://me@server" },
      }),
    ).toThrow(UnsupportedDockerHostError);
  });

  test("falls back to Docker Desktop named pipes on Windows", () => {
    const endpoints = resolveDockerEndpoints({ ...base, platform: "win32", env: {} });
    expect(endpoints.map((e) => e.label)).toEqual([
      "npipe:////./pipe/docker_engine",
      "npipe:////./pipe/dockerDesktopLinuxEngine",
    ]);
  });

  test("falls back to system and Docker Desktop sockets on macOS", () => {
    const endpoints = resolveDockerEndpoints({ ...base, platform: "darwin", env: {} });
    expect(endpoints.map((e) => e.label)).toEqual([
      "unix:///var/run/docker.sock",
      "unix:///home/dev/.docker/run/docker.sock",
    ]);
  });

  test("falls back to system, rootless and Docker Desktop sockets on Linux", () => {
    const endpoints = resolveDockerEndpoints({
      ...base,
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    });
    expect(endpoints.map((e) => e.label)).toEqual([
      "unix:///var/run/docker.sock",
      "unix:///run/user/1000/docker.sock",
      "unix:///home/dev/.docker/desktop/docker.sock",
    ]);
  });

  test("skips the rootless socket on Linux when XDG_RUNTIME_DIR is unset", () => {
    const endpoints = resolveDockerEndpoints({ ...base, platform: "linux", env: {} });
    expect(endpoints.map((e) => e.label)).toEqual([
      "unix:///var/run/docker.sock",
      "unix:///home/dev/.docker/desktop/docker.sock",
    ]);
  });

  test("ignores an empty DOCKER_HOST", () => {
    const endpoints = resolveDockerEndpoints({
      ...base,
      platform: "linux",
      env: { DOCKER_HOST: "" },
    });
    expect(endpoints[0]?.label).toBe("unix:///var/run/docker.sock");
  });
});
