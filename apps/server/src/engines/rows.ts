import { z } from "zod";
import type { ConnectionConfig } from "../connections/types.ts";
import { classifyError } from "./errors.ts";
import type { AdapterContext } from "./types.ts";

/** A text column that some drivers return as a number or bigint. */
export const textish = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => String(value));

export const numberish = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => Number(value))
  .pipe(z.number().finite());

export function parseRows<T extends z.ZodType>(schema: T, rows: unknown[]): z.output<T>[] {
  return z.array(schema).parse(rows);
}

/** Runs a catalog call and turns any failure into a TargetError. */
export async function guarded<T>(
  config: ConnectionConfig,
  ctx: AdapterContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw classifyError(error, config, ctx);
  }
}
