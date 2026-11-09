import type { MiddlewareHandler } from "hono";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Only serves requests addressed to a loopback host (blocks DNS rebinding) and
 * coming from the same origin (blocks cross-site requests, including pages served
 * on other localhost ports). State-changing methods must carry an Origin header.
 */
export function localRequestGuard(): MiddlewareHandler {
  return async (c, next) => {
    const self = loopbackOrigin(c.req.header("host"));
    if (self === null) {
      return c.json({ error: "forbidden_host" }, 403);
    }

    const origin = c.req.header("origin");
    if (origin === undefined ? !SAFE_METHODS.has(c.req.method) : parseOrigin(origin) !== self) {
      return c.json({ error: "forbidden_origin" }, 403);
    }

    await next();
  };
}

function loopbackOrigin(host: string | undefined): string | null {
  if (!host) return null;
  const origin = parseOrigin(`http://${host}`);
  return origin !== null && LOOPBACK_HOSTNAMES.has(new URL(origin).hostname) ? origin : null;
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
