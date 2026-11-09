import type { AppType } from "@dpilot/server/app";
import { hc } from "hono/client";

export const api = hc<AppType>("/").api;

export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    /** The server's machine-readable error code, when it sent one. */
    readonly code: string | null,
    message: string | null,
  ) {
    super(message ?? `Request failed with HTTP ${status}`);
  }
}

interface ClientResponse<T> {
  ok: boolean;
  status: number;
  json(): Promise<T>;
}

/** Body type of the responses Hono's client cannot rule out as successful. */
type OkBody<R> = R extends { ok: false } ? never : R extends ClientResponse<infer T> ? T : never;

/** Unwraps a Hono client response, turning non-2xx statuses into ApiError. */
export async function unwrap<R extends ClientResponse<unknown>>(
  response: Promise<R>,
): Promise<OkBody<R>> {
  const res = await response;
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as OkBody<R>;
}

/** For endpoints that answer 204 No Content. */
export async function unwrapEmpty(response: Promise<ClientResponse<unknown>>): Promise<void> {
  const res = await response;
  if (!res.ok) throw await toApiError(res);
}

async function toApiError(res: ClientResponse<unknown>): Promise<ApiError> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body !== "object" || body === null) return new ApiError(res.status, null, null);
  const { error, message } = body as { error?: unknown; message?: unknown };
  return new ApiError(
    res.status,
    typeof error === "string" ? error : null,
    typeof message === "string" ? message : null,
  );
}
