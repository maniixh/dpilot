import type { AppType } from "@dpilot/server/app";
import { hc } from "hono/client";

export const api = hc<AppType>("/").api;

export class ApiError extends Error {
  override name = "ApiError";

  constructor(readonly status: number) {
    super(`Request failed with HTTP ${status}`);
  }
}

/** Unwraps a Hono client response, turning non-2xx statuses into ApiError. */
export async function unwrap<T>(
  response: Promise<{ ok: boolean; status: number; json(): Promise<T> }>,
) {
  const res = await response;
  if (!res.ok) throw new ApiError(res.status);
  return res.json();
}
