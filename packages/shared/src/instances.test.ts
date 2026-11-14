import { describe, expect, test } from "bun:test";
import { ENGINE_IDS, ENGINES, engineIdSchema, getEngine } from "./catalog.ts";
import { createInstanceRequestSchema, imageTagSchema, instanceNameSchema } from "./instances.ts";

describe("catalog", () => {
  test("lists mysql, mariadb and postgres with distinct images", () => {
    expect([...ENGINE_IDS]).toEqual(["mysql", "mariadb", "postgres"]);
    expect(ENGINES.map((e) => e.image)).toEqual(["mysql", "mariadb", "postgres"]);
  });

  test("every engine has fallback versions and a default port", () => {
    for (const engine of ENGINES) {
      expect(engine.fallbackVersions.length).toBeGreaterThan(0);
      expect(engine.defaultPort).toBeGreaterThan(1023);
      for (const v of engine.fallbackVersions)
        expect(imageTagSchema.safeParse(v).success).toBe(true);
    }
  });

  test("getEngine resolves by id", () => {
    expect(getEngine("postgres").defaultPort).toBe(5432);
    expect(engineIdSchema.safeParse("oracle").success).toBe(false);
  });
});

describe("instanceNameSchema", () => {
  test.each(["db", "my-db-1", "a1"])("accepts %s", (name) => {
    expect(instanceNameSchema.safeParse(name).success).toBe(true);
  });

  test.each(["", "a", "1db", "My-db", "db-", "db_1", "a".repeat(33), "db/../x"])(
    "rejects %p",
    (name) => {
      expect(instanceNameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe("imageTagSchema", () => {
  test.each(["8.4", "17.2", "11.4.5", "latest"])("accepts %s", (tag) => {
    expect(imageTagSchema.safeParse(tag).success).toBe(true);
  });

  test.each(["", "-x", "8.4:evil", "a/b", "8 4"])("rejects %p", (tag) => {
    expect(imageTagSchema.safeParse(tag).success).toBe(false);
  });
});

describe("createInstanceRequestSchema", () => {
  const base = { engine: "mysql", version: "8.4", name: "shop" } as const;

  test("accepts the minimal request", () => {
    expect(createInstanceRequestSchema.parse(base)).toEqual(base);
  });

  test("accepts port and password", () => {
    const req = { ...base, port: 3307, password: "s3cret-pass" };
    expect(createInstanceRequestSchema.parse(req)).toEqual(req);
  });

  test.each(["app", "test_dpilot", "_scratch", "a".repeat(63)])(
    "accepts database %p",
    (database) => {
      expect(createInstanceRequestSchema.safeParse({ ...base, database }).success).toBe(true);
    },
  );

  test.each(["", "test-dpilot", "App", "1db", "a".repeat(64), "x;drop", "db name"])(
    "rejects database %p",
    (database) => {
      expect(createInstanceRequestSchema.safeParse({ ...base, database }).success).toBe(false);
    },
  );

  test.each([
    { ...base, engine: "oracle" },
    { ...base, port: 80 },
    { ...base, port: 70000 },
    { ...base, port: 3306.5 },
    { ...base, password: "short" },
    { ...base, password: "has space in it" },
    { ...base, extra: true },
  ])("rejects %p", (req) => {
    expect(createInstanceRequestSchema.safeParse(req).success).toBe(false);
  });
});
