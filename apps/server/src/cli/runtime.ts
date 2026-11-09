import { randomBytes } from "node:crypto";

/**
 * True when nothing listens on the loopback port, so Docker can publish there. Binding alone
 * misses listeners on 0.0.0.0 on Windows, so also check that nothing accepts connections.
 */
export async function isPortFree(port: number): Promise<boolean> {
  try {
    const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.stop(true);
  } catch {
    return false;
  }
  return !(await acceptsConnections(port));
}

async function acceptsConnections(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}
