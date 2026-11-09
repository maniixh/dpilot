import type { DockerStatus } from "@dpilot/shared";

/** Read-only view of the Docker daemon consumed by HTTP routes. */
export interface DockerClient {
  status(): Promise<DockerStatus>;
}

export type DockerMethod = "GET" | "POST" | "PUT" | "DELETE" | "HEAD";

export interface DockerRequestOptions {
  method: DockerMethod;
  /** Path plus query string, already encoded. */
  path: string;
  /** Serialized as JSON. */
  body?: unknown;
  /** Aborts when no bytes arrive for this long, so long streams stay alive while active. */
  idleTimeoutMs: number;
  /** Cap for buffered bodies. Streamed 2xx bodies are not capped. */
  maxBytes: number;
  /** Receives 2xx response bytes as they arrive instead of buffering them. */
  onData?: (chunk: Uint8Array) => void;
}

export interface DockerResponse {
  status: number;
  /** Empty for streamed 2xx responses. */
  body: Uint8Array;
}

export type DockerCallOptions = Omit<DockerRequestOptions, "idleTimeoutMs" | "maxBytes"> &
  Partial<Pick<DockerRequestOptions, "idleTimeoutMs" | "maxBytes">>;

/** A Docker client that can also issue raw Engine API requests. */
export interface DockerConnection extends DockerClient {
  request(options: DockerCallOptions): Promise<DockerResponse>;
}

/** Docker is not running or not reachable; routes answer 503. */
export class DockerUnavailableError extends Error {
  override name = "DockerUnavailableError";
}

/** Docker accepted the request but stopped sending data; routes answer 504. */
export class DockerTimeoutError extends Error {
  override name = "DockerTimeoutError";
}
