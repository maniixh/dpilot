import { afterEach, expect, test } from "bun:test";
import { explorerRequests } from "./explorer.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureUrls(): string[] {
  const urls: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      urls.push(input instanceof Request ? input.url : String(input));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    },
    { preconnect: realFetch.preconnect },
  );
  return urls;
}

test("encodes database names with slashes, question marks and quotes in the path", async () => {
  const urls = captureUrls();
  await explorerRequests.schemas("s.orders", 'a/b?c"d');
  await explorerRequests.objects("s.orders", "x#y", "sales team");
  expect(urls[0]).toEndWith("/api/c/s.orders/db/a%2Fb%3Fc%22d/schemas");
  expect(urls[1]).toEndWith("/api/c/s.orders/db/x%23y/objects?schema=sales+team");
});
