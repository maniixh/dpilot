import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { sessionTokenSchema } from "@dpilot/shared";

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Dev mode restarts on every file change; reusing the token keeps the browser
 * session valid across restarts. Production always uses a fresh token.
 */
export function loadOrCreateDevToken(filePath: string): string {
  const existing = readExisting(filePath);
  if (existing) return existing;

  const token = generateSessionToken();
  writeFileSync(filePath, token, { mode: 0o600 });
  return token;
}

function readExisting(filePath: string): string | null {
  try {
    const parsed = sessionTokenSchema.safeParse(readFileSync(filePath, "utf8").trim());
    return parsed.success ? parsed.data : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
