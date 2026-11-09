import { describe, expect, test } from "bun:test";
import { ApiError, unwrap, unwrapEmpty } from "./client.ts";

function response(status: number, body: string) {
  return Promise.resolve(new Response(body || null, { status }));
}

describe("unwrap", () => {
  test("returns the JSON body of a 2xx response", async () => {
    expect(await unwrap(response(200, '{"a":1}'))).toEqual({ a: 1 });
  });

  test("carries the server's error code and message", async () => {
    const error = await unwrap(
      response(409, '{"error":"conflict","message":"An instance named \\"shop\\" already exists"}'),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      message: 'An instance named "shop" already exists',
    });
  });

  test("falls back to a generic message for non-JSON errors", async () => {
    const error = await unwrap(response(500, "<html>")).catch((e: unknown) => e);

    expect(error).toMatchObject({
      status: 500,
      code: null,
      message: "Request failed with HTTP 500",
    });
  });
});

describe("unwrapEmpty", () => {
  test("accepts 204 and rejects errors", async () => {
    expect(await unwrapEmpty(response(204, ""))).toBeUndefined();
    expect(unwrapEmpty(response(404, '{"error":"not_found"}'))).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
