import type { Server } from "bun";

export class PortInUseError extends Error {
  override name = "PortInUseError";
}

export interface StartServerOptions {
  port: number;
  allowFallback: boolean;
  fetch: (request: Request) => Response | Promise<Response>;
}

const FALLBACK_ATTEMPTS = 20;

/** Starts the HTTP server on loopback only, trying later ports when allowed. */
export function startServer(options: StartServerOptions): Server<undefined> {
  const attempts = options.allowFallback ? FALLBACK_ATTEMPTS : 1;

  for (let offset = 0; offset < attempts; offset++) {
    const port = options.port + offset;
    try {
      return Bun.serve({ hostname: "127.0.0.1", port, fetch: options.fetch });
    } catch (error) {
      if (!isAddressInUse(error)) throw error;
    }
  }

  const last = options.port + attempts - 1;
  throw new PortInUseError(
    attempts === 1
      ? `Port ${options.port} is already in use`
      : `Ports ${options.port}-${last} are all in use`,
  );
}

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "EADDRINUSE"
  );
}
