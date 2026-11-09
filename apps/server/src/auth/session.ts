import { createSessionRequestSchema } from "@dpilot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";

/**
 * Browsers share cookies across ports on the same host, so the cookie name carries
 * the port. Otherwise two Dpilot instances would overwrite each other's session.
 */
export function sessionCookieName(host: string): string {
  return `dpilot_session_${new URL(`http://${host}`).port || "80"}`;
}

function cookieNameFor(host: string | undefined): string | null {
  if (!host) return null;
  try {
    return sessionCookieName(host);
  } catch {
    return null;
  }
}

export function requireSession(token: string): MiddlewareHandler {
  return async (c, next) => {
    const name = cookieNameFor(c.req.header("host"));
    const presented = name === null ? undefined : getCookie(c, name);
    if (!presented || !constantTimeEqual(presented, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/** Exchanges the one-time URL token for an HttpOnly session cookie. */
export function sessionRoutes(token: string) {
  return new Hono().post(
    "/",
    zValidator("json", createSessionRequestSchema, (result, c) => {
      if (!result.success) return c.json({ error: "invalid_request" }, 400);
    }),
    (c) => {
      if (!constantTimeEqual(c.req.valid("json").token, token)) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const name = cookieNameFor(c.req.header("host"));
      if (name === null) return c.json({ error: "invalid_request" }, 400);
      setCookie(c, name, token, { httpOnly: true, sameSite: "Strict", path: "/" });
      return c.body(null, 204);
    },
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
