import { afterEach, describe, expect, test } from "bun:test";
import {
  closeFakeEngines,
  missingEndpoint,
  startFakeEngine,
} from "../testing/fake-docker-engine.ts";
import { DockerTimeoutError, DockerTransportError, dockerRequest } from "./http.ts";

afterEach(closeFakeEngines);

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const base = { idleTimeoutMs: 2000, maxBytes: 1024 * 1024 };

describe("dockerRequest", () => {
  test("sends a JSON body and returns status and body", async () => {
    const engine = await startFakeEngine((req) => ({
      status: 201,
      body: JSON.stringify({ got: JSON.parse(req.body), type: req.headers["content-type"] }),
    }));

    const res = await dockerRequest(engine.endpoint, {
      ...base,
      method: "POST",
      path: "/containers/create?name=x",
      body: { Image: "mysql:8.4" },
    });

    expect(res.status).toBe(201);
    expect(JSON.parse(decode(res.body))).toEqual({
      got: { Image: "mysql:8.4" },
      type: "application/json",
    });
    expect(engine.requests[0]?.method).toBe("POST");
    expect(engine.requests[0]?.path).toBe("/containers/create?name=x");
  });

  test("returns non-2xx responses instead of throwing", async () => {
    const engine = await startFakeEngine(() => ({ status: 404, body: '{"message":"nope"}' }));

    const res = await dockerRequest(engine.endpoint, { ...base, method: "GET", path: "/x" });

    expect(res.status).toBe(404);
    expect(decode(res.body)).toBe('{"message":"nope"}');
  });

  test("streams 2xx bodies to onData without buffering them", async () => {
    const engine = await startFakeEngine(() => ({
      status: 200,
      chunks: [{ data: "a\n" }, { data: "b\n", delayMs: 20 }, { data: "c\n", delayMs: 20 }],
    }));
    const received: string[] = [];

    const res = await dockerRequest(engine.endpoint, {
      ...base,
      method: "POST",
      path: "/images/create",
      onData: (chunk) => received.push(decode(chunk)),
    });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
    expect(received.join("")).toBe("a\nb\nc\n");
  });

  test("idle timeout resets while data keeps flowing", async () => {
    const engine = await startFakeEngine(() => ({
      status: 200,
      chunks: [1, 2, 3, 4].map((n) => ({ data: `${n}`, delayMs: 80 })),
    }));
    let text = "";

    await dockerRequest(engine.endpoint, {
      ...base,
      idleTimeoutMs: 200,
      method: "GET",
      path: "/s",
      onData: (chunk) => {
        text += decode(chunk);
      },
    });

    expect(text).toBe("1234");
  });

  test("rejects with DockerTimeoutError when the stream stalls", async () => {
    const engine = await startFakeEngine(() => ({
      status: 200,
      chunks: [{ data: "x" }],
      stallAfter: true,
    }));

    const promise = dockerRequest(engine.endpoint, {
      ...base,
      idleTimeoutMs: 150,
      method: "GET",
      path: "/s",
      onData: () => {},
    });

    await expect(promise).rejects.toBeInstanceOf(DockerTimeoutError);
  });

  test("rejects buffered bodies larger than maxBytes", async () => {
    const engine = await startFakeEngine(() => ({ status: 200, body: "x".repeat(5000) }));

    const promise = dockerRequest(engine.endpoint, {
      ...base,
      maxBytes: 1000,
      method: "GET",
      path: "/big",
    });

    await expect(promise).rejects.toThrow("too large");
  });

  test("rejects with DockerTransportError when nothing listens", async () => {
    const promise = dockerRequest(missingEndpoint(), { ...base, method: "GET", path: "/x" });

    await expect(promise).rejects.toBeInstanceOf(DockerTransportError);
  });
});
