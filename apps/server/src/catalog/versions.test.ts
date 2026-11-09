import { describe, expect, test } from "bun:test";
import { getEngine } from "@dpilot/shared";
import { createDockerHubVersions, type HttpGet, pickVersions } from "./versions.ts";

describe("pickVersions", () => {
  test("keeps numeric tags, floating tags first, newest first, deduplicated", () => {
    expect(
      pickVersions([
        "latest",
        "17.6",
        "18",
        "17",
        "18.1",
        "8.4.3-oraclelinux9",
        "18.0",
        "17.10",
        "17.6",
        "bookworm",
      ]),
    ).toEqual(["18", "18.1", "18.0", "17", "17.10", "17.6"]);
  });

  test("caps the list length", () => {
    const tags = Array.from({ length: 80 }, (_, i) => `1.${i}`);
    expect(pickVersions(tags)).toHaveLength(40);
  });
});

function hubResponse(names: string[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: names.map((name) => ({ name })) }),
  };
}

describe("createDockerHubVersions", () => {
  test("fetches official image tags from Docker Hub", async () => {
    const urls: string[] = [];
    const get: HttpGet = async (url) => {
      urls.push(url);
      return hubResponse(["8.4", "9.4", "latest"]);
    };
    const source = createDockerHubVersions({ get, now: () => 0 });

    expect(await source.versions("mysql")).toEqual({
      engine: "mysql",
      versions: ["9.4", "8.4"],
      source: "docker-hub",
    });
    expect(urls).toEqual([
      "https://hub.docker.com/v2/repositories/library/mysql/tags?page_size=100&ordering=last_updated",
    ]);
  });

  test("caches results for an hour per engine", async () => {
    let calls = 0;
    let clock = 0;
    const source = createDockerHubVersions({
      get: async () => {
        calls += 1;
        return hubResponse(["1.0"]);
      },
      now: () => clock,
    });

    await source.versions("postgres");
    clock = 59 * 60_000;
    await source.versions("postgres");
    expect(calls).toBe(1);
    clock = 61 * 60_000;
    await source.versions("postgres");
    expect(calls).toBe(2);
  });

  test("shares one in-flight request between concurrent callers", async () => {
    let calls = 0;
    const source = createDockerHubVersions({
      get: async () => {
        calls += 1;
        return hubResponse(["1.0"]);
      },
      now: () => 0,
    });

    await Promise.all([source.versions("mysql"), source.versions("mysql")]);
    expect(calls).toBe(1);
  });

  test.each([
    ["a network error", async () => Promise.reject(new Error("offline"))],
    ["an HTTP error", async () => ({ ok: false, status: 503, json: async () => ({}) })],
    ["an unexpected body", async () => ({ ok: true, status: 200, json: async () => ({ x: 1 }) })],
    ["no usable tags", async () => hubResponse(["latest", "alpine"])],
  ] as [string, HttpGet][])("falls back to the catalog list on %s", async (_label, get) => {
    const source = createDockerHubVersions({ get, now: () => 0 });

    expect(await source.versions("mariadb")).toEqual({
      engine: "mariadb",
      versions: [...getEngine("mariadb").fallbackVersions],
      source: "fallback",
    });
  });

  test("retries Docker Hub five minutes after a fallback", async () => {
    let clock = 0;
    let fail = true;
    const source = createDockerHubVersions({
      get: async () => {
        if (fail) throw new Error("offline");
        return hubResponse(["2.0"]);
      },
      now: () => clock,
    });

    await source.versions("mysql");
    fail = false;
    expect((await source.versions("mysql")).source).toBe("fallback");
    clock = 5 * 60_000 + 1;
    expect((await source.versions("mysql")).source).toBe("docker-hub");
  });
});
