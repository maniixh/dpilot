import { describe, expect, test } from "bun:test";
import { composeYaml } from "./compose.ts";
import {
  buildContainerSpec,
  connectionFor,
  containerName,
  engineSpec,
  labelsFor,
  volumeName,
} from "./engine-specs.ts";

describe("naming", () => {
  test("derives container and volume names from the instance name", () => {
    expect(containerName("shop")).toBe("dpilot-shop");
    expect(volumeName("shop")).toBe("dpilot_shop_data");
  });

  test("labels carry everything needed to list an instance without inspecting it", () => {
    expect(labelsFor({ name: "shop", engine: "mysql", version: "8.4", port: 3307 })).toEqual({
      "dpilot.managed": "true",
      "dpilot.instance": "shop",
      "dpilot.engine": "mysql",
      "dpilot.version": "8.4",
      "dpilot.port": "3307",
    });
  });
});

describe("engineSpec", () => {
  test("mysql uses MYSQL_ROOT_PASSWORD and a TCP mysqladmin ping", () => {
    const spec = engineSpec("mysql");
    expect(spec.env("pw")).toEqual(["MYSQL_ROOT_PASSWORD=pw"]);
    expect(spec.passwordFromEnv({ MYSQL_ROOT_PASSWORD: "pw" })).toBe("pw");
    expect(spec.healthcheck.join(" ")).toContain("mysqladmin ping -h 127.0.0.1");
    expect(spec.dataPath("8.4")).toBe("/var/lib/mysql");
  });

  test("mariadb uses its bundled healthcheck script", () => {
    const spec = engineSpec("mariadb");
    expect(spec.env("pw")).toEqual(["MARIADB_ROOT_PASSWORD=pw"]);
    expect(spec.healthcheck).toEqual([
      "CMD",
      "healthcheck.sh",
      "--connect",
      "--innodb_initialized",
    ]);
  });

  test.each([
    ["17", "/var/lib/postgresql/data"],
    ["16.4", "/var/lib/postgresql/data"],
    ["18", "/var/lib/postgresql"],
    ["18.1", "/var/lib/postgresql"],
    ["latest", "/var/lib/postgresql"],
  ])("postgres %s stores data in %s", (version, path) => {
    expect(engineSpec("postgres").dataPath(version)).toBe(path);
  });

  test("postgres checks readiness over TCP", () => {
    const spec = engineSpec("postgres");
    expect(spec.env("pw")).toEqual(["POSTGRES_USER=postgres", "POSTGRES_PASSWORD=pw"]);
    expect(spec.healthcheck).toEqual(["CMD-SHELL", "pg_isready -U postgres -h 127.0.0.1"]);
  });
});

describe("connectionFor", () => {
  test("builds an encoded URL bound to localhost", () => {
    expect(connectionFor("postgres", 5433, "p@ss/word")).toEqual({
      host: "127.0.0.1",
      port: 5433,
      user: "postgres",
      password: "p@ss/word",
      url: "postgres://postgres:p%40ss%2Fword@127.0.0.1:5433/postgres",
    });
    expect(connectionFor("mariadb", 3306, "pw").url).toBe("mysql://root:pw@127.0.0.1:3306");
  });
});

describe("buildContainerSpec", () => {
  test("binds to 127.0.0.1 only, mounts the named volume and adds a healthcheck", () => {
    const spec = buildContainerSpec({
      name: "shop",
      engine: "postgres",
      version: "17",
      port: 5433,
      password: "pw",
    });

    expect(spec.Image).toBe("postgres:17");
    expect(spec.ExposedPorts).toEqual({ "5432/tcp": {} });
    expect(spec.HostConfig.PortBindings).toEqual({
      "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5433" }],
    });
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: "dpilot_shop_data", Target: "/var/lib/postgresql/data" },
    ]);
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: "no" });
    expect(spec.Labels["dpilot.port"]).toBe("5433");
    expect(spec.Healthcheck?.Test[0]).toBe("CMD-SHELL");
    expect(spec.Healthcheck?.Interval).toBe(3_000_000_000);
  });
});

describe("composeYaml", () => {
  const yaml = composeYaml({
    name: "shop",
    engine: "mysql",
    version: "8.4",
    port: 3307,
    password: 'p$w"d',
  });

  test("describes the same container, port, volume and healthcheck", () => {
    expect(yaml).toContain('image: "mysql:8.4"');
    expect(yaml).toContain('container_name: "dpilot-shop"');
    expect(yaml).toContain('- "127.0.0.1:3307:3306"');
    expect(yaml).toContain('- "data:/var/lib/mysql"');
    expect(yaml).toContain('name: "dpilot_shop_data"');
    expect(yaml).toContain("healthcheck:");
  });

  test("escapes $ for compose interpolation and quotes values", () => {
    expect(yaml).toContain('MYSQL_ROOT_PASSWORD: "p$$w\\"d"');
    expect(yaml).toContain('-p\\"$$MYSQL_ROOT_PASSWORD\\"');
  });
});
