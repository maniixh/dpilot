import { z } from "zod";
import { type EngineId, engineIdSchema } from "./catalog.ts";

export const tlsModeSchema = z.enum(["off", "require", "verify"]);
export type TlsMode = z.infer<typeof tlsModeSchema>;

export const tlsSettingsSchema = z
  .object({
    mode: tlsModeSchema,
    ca: z
      .string()
      .max(65_536)
      .refine((value) => value.includes("-----BEGIN CERTIFICATE-----"), {
        message: "Paste a PEM certificate",
      })
      .nullable(),
  })
  .strict()
  .refine((tls) => tls.ca === null || tls.mode === "verify", {
    message: "A CA certificate is only used with verify mode",
    path: ["ca"],
  });
export type TlsSettings = z.infer<typeof tlsSettingsSchema>;

const connectionFields = {
  label: z.string().trim().min(1).max(64),
  engine: engineIdSchema,
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$|^[0-9A-Fa-f:]+$/, "Use a host name or IP address"),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(128),
  password: z.string().max(1024).nullable().optional(),
  database: z.string().min(1).max(128).nullable().optional(),
  tls: tlsSettingsSchema,
};

export const connectionInputSchema = z.object(connectionFields).strict();
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

export const connectionPatchSchema = connectionInputSchema.partial().strict();
export type ConnectionPatch = z.infer<typeof connectionPatchSchema>;

export const connectionTestRequestSchema = z.union([
  connectionInputSchema,
  connectionPatchSchema.extend({ id: z.uuid() }).strict(),
]);
export type ConnectionTestRequest = z.infer<typeof connectionTestRequestSchema>;

export interface SavedConnection {
  id: string;
  label: string;
  engine: EngineId;
  host: string;
  port: number;
  username: string;
  database: string | null;
  tls: TlsSettings;
  hasPassword: boolean;
  /** A password was saved but Dpilot can no longer read it. */
  passwordLost: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `s.<instance name>` for Dpilot servers, `c.<uuid>` for saved connections. */
export const targetIdSchema = z
  .string()
  .regex(/^s\.[a-z][a-z0-9-]{0,29}[a-z0-9]$|^c\.[0-9a-f-]{36}$/);
export type TargetId = string;

export type ParsedTargetId = { kind: "server"; name: string } | { kind: "connection"; id: string };

export function parseTargetId(id: string): ParsedTargetId | null {
  if (!targetIdSchema.safeParse(id).success) return null;
  const rest = id.slice(2);
  return id.startsWith("s.") ? { kind: "server", name: rest } : { kind: "connection", id: rest };
}

export type TargetSummary = {
  id: TargetId;
  kind: "server" | "connection";
  label: string;
  engine: EngineId;
} & ({ available: true } | { available: false; reason: string });

export interface TargetsResponse {
  servers: { status: "ok"; targets: TargetSummary[] } | { status: "unavailable"; message: string };
  connections: TargetSummary[];
}

export interface ServerInfo {
  engine: EngineId;
  version: string;
  user: string;
  uptimeSeconds: number | null;
  charset: string | null;
  timeZone: string | null;
}

export interface ServerVariable {
  name: string;
  value: string;
  description: string | null;
}

export interface DatabaseEntry {
  name: string;
  system: boolean;
  browsable: boolean;
}

export interface SchemaEntry {
  name: string;
}

export interface ObjectGroups {
  tables: string[];
  views: string[];
  procedures: string[];
  functions: string[];
}

export type TargetErrorCode =
  | "target_not_found"
  | "target_unavailable"
  | "password_lost"
  | "auth_failed"
  | "unreachable"
  | "tls_failed"
  | "timeout"
  | "query_failed";

export type TestResult =
  | { ok: true; info: ServerInfo }
  | { ok: false; code: TargetErrorCode; message: string };
