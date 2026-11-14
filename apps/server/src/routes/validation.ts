import type { Context } from "hono";
import { type core, z } from "zod";

type ValidationResult = { success: true } | { success: false; error: core.$ZodError };

/** zValidator hook: 400 with field issues, matching the instance routes. */
export function invalidRequest(result: ValidationResult, c: Context) {
  if (!result.success) {
    return c.json(
      { error: "invalid_request" as const, issues: z.flattenError(result.error).fieldErrors },
      400,
    );
  }
}
