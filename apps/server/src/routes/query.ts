import { queryRequestSchema } from "@dpilot/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { QueryService } from "../query/types.ts";
import { invalidRequest } from "./validation.ts";

const targetParam = z.object({ target: z.string() });
const cancelParam = targetParam.extend({ runId: z.uuid() });
const tabParam = targetParam.extend({ tab: z.uuid() });

export function queryRoutes(query: QueryService) {
  return new Hono()
    .post(
      "/:target/query",
      zValidator("param", targetParam, invalidRequest),
      zValidator("json", queryRequestSchema, invalidRequest),
      async (c) => c.json(await query.run(c.req.valid("param").target, c.req.valid("json"))),
    )
    .post(
      "/:target/query/:runId/cancel",
      zValidator("param", cancelParam, invalidRequest),
      async (c) => {
        const { target, runId } = c.req.valid("param");
        await query.cancel(target, runId);
        return c.body(null, 204);
      },
    )
    .delete("/:target/sessions/:tab", zValidator("param", tabParam, invalidRequest), async (c) => {
      const { target, tab } = c.req.valid("param");
      await query.closeTab(target, tab);
      return c.body(null, 204);
    });
}
