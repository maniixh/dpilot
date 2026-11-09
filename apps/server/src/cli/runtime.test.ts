import { describe, expect, test } from "bun:test";
import { generatePassword, isPortFree } from "./runtime.ts";

describe("isPortFree", () => {
  test("reports a bound loopback port as taken and a released one as free", async () => {
    const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = holder.port;

    expect(await isPortFree(port)).toBe(false);
    holder.stop(true);
    expect(await isPortFree(port)).toBe(true);
  });

  test("reports a port held on all interfaces as taken", async () => {
    const holder = Bun.listen({ hostname: "0.0.0.0", port: 0, socket: { data() {} } });

    expect(await isPortFree(holder.port)).toBe(false);
    holder.stop(true);
  });
});

describe("generatePassword", () => {
  test("produces distinct URL-safe passwords valid for instances", () => {
    const a = generatePassword();
    const b = generatePassword();

    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
  });
});
