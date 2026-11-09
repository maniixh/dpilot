import { request } from "node:http";
import type { DockerEndpoint } from "./endpoint.ts";
import { type DockerRequestOptions, type DockerResponse, DockerTimeoutError } from "./types.ts";

export { DockerTimeoutError };

/** The engine could not be reached at all (no socket, refused, reset before a response). */
export class DockerTransportError extends Error {
  override name = "DockerTransportError";
}

/**
 * One HTTP request to the Docker Engine API using node:http, which (unlike fetch)
 * supports Windows named pipes in Bun via `socketPath`.
 */
export function dockerRequest(
  endpoint: DockerEndpoint,
  options: DockerRequestOptions,
): Promise<DockerResponse> {
  const target =
    endpoint.transport === "socket"
      ? { socketPath: endpoint.socketPath }
      : { hostname: new URL(endpoint.baseUrl).hostname, port: new URL(endpoint.baseUrl).port };
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = { host: "docker" };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }

  return new Promise((resolve, reject) => {
    let responded = false;
    const req = request(
      { ...target, path: options.path, method: options.method, headers },
      (res) => {
        responded = true;
        const status = res.statusCode ?? 0;
        const stream = options.onData !== undefined && status >= 200 && status < 300;
        const chunks: Buffer[] = [];
        let size = 0;
        let overflow = false;
        res.on("data", (chunk: Buffer) => {
          if (stream) {
            options.onData?.(chunk);
            return;
          }
          size += chunk.length;
          if (size > options.maxBytes) {
            overflow = true;
            reject(new Error("Docker response too large"));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (!overflow) resolve({ status, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
        // No-op after "end"; covers connections that close mid-response.
        res.on("close", () => reject(new Error("Docker closed the connection early")));
      },
    );
    req.setTimeout(options.idleTimeoutMs, () =>
      req.destroy(
        new DockerTimeoutError(`Docker did not respond within ${options.idleTimeoutMs}ms`),
      ),
    );
    req.on("error", (error) => {
      reject(
        error instanceof DockerTimeoutError || responded
          ? error
          : new DockerTransportError(error.message),
      );
    });
    req.end(payload);
  });
}
