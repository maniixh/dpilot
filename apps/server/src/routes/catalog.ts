import { ENGINES, engineIdSchema } from "@dpilot/shared";
import { Hono } from "hono";
import type { VersionSource } from "../catalog/versions.ts";

export function catalogRoutes(versions: VersionSource) {
  return new Hono()
    .get("/engines", (c) => c.json(ENGINES))
    .get("/engines/:engine/versions", async (c) => {
      const engine = engineIdSchema.safeParse(c.req.param("engine"));
      if (!engine.success) return c.json({ error: "not_found" as const }, 404);
      return c.json(await versions.versions(engine.data));
    });
}
