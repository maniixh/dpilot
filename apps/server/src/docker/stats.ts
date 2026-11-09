import type { InstanceStats } from "@dpilot/shared";
import { z } from "zod";

const cpuSchema = z.object({
  cpu_usage: z.object({ total_usage: z.number() }),
  system_cpu_usage: z.number().optional(),
  online_cpus: z.number().optional(),
});

export const statsResponseSchema = z.object({
  cpu_stats: cpuSchema,
  precpu_stats: cpuSchema.partial({ cpu_usage: true }).optional(),
  memory_stats: z.object({
    usage: z.number().optional(),
    limit: z.number().optional(),
    stats: z.record(z.string(), z.number()).optional(),
  }),
});

export type StatsResponse = z.infer<typeof statsResponseSchema>;

/** Same formulas as `docker stats`. */
export function computeStats(raw: StatsResponse): InstanceStats {
  const cpu = raw.cpu_stats;
  const pre = raw.precpu_stats;
  const cpuDelta = cpu.cpu_usage.total_usage - (pre?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (cpu.system_cpu_usage ?? 0) - (pre?.system_cpu_usage ?? 0);
  const hasPrevious = pre?.system_cpu_usage !== undefined && pre.system_cpu_usage > 0;
  const cpuPercent =
    hasPrevious && cpuDelta > 0 && systemDelta > 0
      ? (cpuDelta / systemDelta) * (cpu.online_cpus ?? 1) * 100
      : 0;

  const memory = raw.memory_stats;
  const cache = memory.stats?.inactive_file ?? memory.stats?.total_inactive_file ?? 0;
  const memoryBytes = Math.max(0, (memory.usage ?? 0) - cache);

  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryBytes,
    memoryLimitBytes: memory.limit ?? 0,
  };
}
