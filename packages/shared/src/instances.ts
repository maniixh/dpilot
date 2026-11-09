import { z } from "zod";
import { type EngineId, engineIdSchema } from "./catalog.ts";

/** Lowercase, starts with a letter, 2-31 chars; safe inside container and volume names. */
export const instanceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,29}[a-z0-9]$/);

/** Docker tag grammar. */
export const imageTagSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);

export const instancePasswordSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, "Use printable ASCII without spaces");

export const createInstanceRequestSchema = z
  .object({
    engine: engineIdSchema,
    version: imageTagSchema,
    name: instanceNameSchema,
    port: z.number().int().min(1024).max(65535).optional(),
    password: instancePasswordSchema.optional(),
  })
  .strict();

export type CreateInstanceRequest = z.infer<typeof createInstanceRequestSchema>;

export interface PullProgress {
  /** Bytes downloaded across layers that report a total. */
  currentBytes: number;
  totalBytes: number;
  layersDone: number;
  layersTotal: number;
}

export type InstanceState =
  | { status: "pulling"; progress: PullProgress }
  | { status: "creating" }
  | { status: "failed"; error: string }
  | { status: "starting" }
  | { status: "ready" }
  | { status: "unhealthy" }
  | { status: "stopped"; exitCode: number | null }
  | { status: "restarting" }
  | { status: "paused" }
  | { status: "dead" };

export type InstanceStatus = InstanceState["status"];

export interface InstanceSummary {
  name: string;
  engine: EngineId;
  version: string;
  port: number;
  state: InstanceState;
}

export interface InstanceConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  url: string;
}

export interface InstanceDetail extends InstanceSummary {
  /** Absent while the instance is still being provisioned. */
  connection: InstanceConnection | null;
  image: string;
  volume: string;
  containerId: string | null;
  createdAt: string | null;
}

export interface InstanceStats {
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
}

export interface InstanceLogs {
  lines: string[];
}

export interface InstanceCompose {
  fileName: string;
  yaml: string;
}
