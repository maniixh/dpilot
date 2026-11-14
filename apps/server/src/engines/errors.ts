import type { ConnectionConfig } from "../connections/types.ts";
import { type AdapterContext, TargetError } from "./types.ts";

const MANAGED_AUTH_HINT =
  " Dpilot uses the password the server was created with. If you changed it inside the server, " +
  "change it back or add the server as a saved connection.";

interface DriverFields {
  code: string;
  errno: string | number | null;
  message: string;
}

function fieldsOf(error: unknown): DriverFields {
  if (!(error instanceof Error)) return { code: "", errno: null, message: String(error) };
  const record = error as Error & { code?: unknown; errno?: unknown };
  const errno =
    typeof record.errno === "string" || typeof record.errno === "number" ? record.errno : null;
  const code = typeof record.code === "string" ? record.code : "";
  return { code, errno, message: error.message };
}

const AUTH_ERRNOS = new Set<string | number>(["28P01", "28000", 1045]);
const DENIED_ERRNOS = new Set<string | number>(["42501", 1044, 1227]);
const UNREACHABLE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"]);

/** Turns a Bun.SQL (or socket) failure into a TargetError with a plain message. */
export function classifyError(
  error: unknown,
  config: ConnectionConfig,
  ctx: AdapterContext,
): TargetError {
  if (error instanceof TargetError) return error;
  const { code, errno, message } = fieldsOf(error);
  const upper = code.toUpperCase();
  if (errno !== null && AUTH_ERRNOS.has(errno)) {
    const base = `The server rejected user ${config.username}. Check the user and password.`;
    return new TargetError("auth_failed", ctx.managed ? base + MANAGED_AUTH_HINT : base);
  }
  if (UNREACHABLE_CODES.has(upper) || upper.includes("CONNECTION_REFUSED")) {
    return new TargetError(
      "unreachable",
      `Nothing answered at ${config.host}:${config.port}. Check the host and port.`,
    );
  }
  if (upper.includes("TIMEOUT") || upper === "ETIMEDOUT") {
    return new TargetError("timeout", "The server didn't answer within 10 seconds.");
  }
  const tlsText = errno === null ? `${upper} ${message.toUpperCase()}` : upper;
  if (/TLS|SSL|CERT/.test(tlsText)) {
    return new TargetError("tls_failed", `The TLS handshake failed: ${message}`);
  }
  return new TargetError("query_failed", message);
}

/** True when the server refused a catalog query for lack of privileges. */
export function isPermissionDenied(error: unknown): boolean {
  const { errno } = fieldsOf(error);
  return errno !== null && DENIED_ERRNOS.has(errno);
}
