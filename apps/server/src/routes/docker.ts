import { Hono } from "hono";
import type { DockerClient } from "../docker/types.ts";

export function dockerRoutes(docker: DockerClient) {
  return new Hono().get("/status", async (c) => c.json(await docker.status()));
}
