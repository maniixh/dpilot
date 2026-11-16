import { afterEach, expect, test } from "bun:test";
import { ApiError } from "./client.ts";
import { cellUrl, dataRequests } from "./data.ts";
import { queryRequests } from "./query.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondWith(status: number, body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: realFetch.preconnect },
  );
  return urls;
}

const request = {
  runId: "0b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11",
  sql: "DELETE FROM t",
  database: null,
  tab: "1b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11",
  maxRows: 1000,
  confirmed: false,
};

test("run maps a 409 confirmation_required to kind confirm", async () => {
  const statements = [{ index: 0, sql: "DELETE FROM t", reasons: ["DELETE without WHERE"] }];
  respondWith(409, { error: "confirmation_required", message: "Confirm", statements });
  expect(await queryRequests.run("s.app", request)).toEqual({ kind: "confirm", statements });
});

test("run returns the run on success", async () => {
  const run = {
    runId: request.runId,
    outcomes: [],
    omitted: 0,
    summary: { statements: 1, succeeded: 1, affected: 0 },
    stopped: null,
    durationMs: 3,
  };
  respondWith(200, run);
  expect(await queryRequests.run("s.app", request)).toEqual({ kind: "run", run });
});

test("run keeps other 409 errors as ApiError", async () => {
  respondWith(409, { error: "busy", message: "This tab is already running a query." });
  const error = await queryRequests.run("s.app", request).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe("busy");
});

test("encodes target, database and table names in table requests", async () => {
  const urls = respondWith(200, {});
  await dataRequests.table("s.app", 'a/b?c"d', { schema: "my schema", table: "t#1" });
  expect(urls[0]).toEndWith("/api/c/s.app/db/a%2Fb%3Fc%22d/table?schema=my+schema&table=t%231");
});

test("cellUrl encodes names and sends the key as JSON text", () => {
  const url = cellUrl(
    "s.app",
    "a/b",
    { schema: null, table: "t" },
    { id: "9007199254740993" },
    "c",
  );
  expect(url).toBe(
    "/api/c/s.app/db/a%2Fb/cell?table=t&column=c&key=%7B%22id%22%3A%229007199254740993%22%7D",
  );
});
