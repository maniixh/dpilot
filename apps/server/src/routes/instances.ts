import { createInstanceRequestSchema } from "@dpilot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { InstanceService } from "../instances/service.ts";

const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 5000;

const removeQuerySchema = z.object({
  removeVolume: z.enum(["true", "false"]).optional(),
});

const logsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(MAX_LOG_TAIL).optional(),
});

const actionSchema = z.object({ action: z.enum(["start", "stop", "restart"]) });

const invalid = { error: "invalid_request" as const };

export function instanceRoutes(instances: InstanceService) {
  return new Hono()
    .get("/", async (c) => c.json(await instances.list()))
    .post(
      "/",
      zValidator("json", createInstanceRequestSchema, (result, c) => {
        if (!result.success) {
          return c.json({ ...invalid, issues: z.flattenError(result.error).fieldErrors }, 400);
        }
      }),
      async (c) => c.json(await instances.create(c.req.valid("json")), 202),
    )
    .get("/:name", async (c) => c.json(await instances.get(c.req.param("name"))))
    .delete(
      "/:name",
      zValidator("query", removeQuerySchema, (result, c) => {
        if (!result.success) return c.json(invalid, 400);
      }),
      async (c) => {
        const removeVolume = c.req.valid("query").removeVolume === "true";
        await instances.remove(c.req.param("name"), { removeVolume });
        return c.body(null, 204);
      },
    )
    .post(
      "/:name/:action",
      zValidator("param", actionSchema.extend({ name: z.string() }), (result, c) => {
        if (!result.success) return c.json({ error: "not_found" as const }, 404);
      }),
      async (c) => {
        const { name, action } = c.req.valid("param");
        await instances[action](name);
        return c.body(null, 204);
      },
    )
    .get(
      "/:name/logs",
      zValidator("query", logsQuerySchema, (result, c) => {
        if (!result.success) return c.json(invalid, 400);
      }),
      async (c) =>
        c.json(
          await instances.logs(c.req.param("name"), c.req.valid("query").tail ?? DEFAULT_LOG_TAIL),
        ),
    )
    .get("/:name/stats", async (c) => c.json(await instances.stats(c.req.param("name"))))
    .get("/:name/compose", async (c) => c.json(await instances.compose(c.req.param("name"))));
}
