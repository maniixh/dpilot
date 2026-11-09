import { z } from "zod";

export const ENGINE_IDS = ["mysql", "mariadb", "postgres"] as const;

export const engineIdSchema = z.enum(ENGINE_IDS);

export type EngineId = z.infer<typeof engineIdSchema>;

export interface EngineInfo {
  id: EngineId;
  label: string;
  /** Docker Hub official image name. */
  image: string;
  defaultPort: number;
  defaultUser: string;
  /** Used when Docker Hub cannot be reached. Newest first. */
  fallbackVersions: readonly string[];
}

export const ENGINES: readonly EngineInfo[] = [
  {
    id: "mysql",
    label: "MySQL",
    image: "mysql",
    defaultPort: 3306,
    defaultUser: "root",
    fallbackVersions: ["9.4", "8.4", "8.0"],
  },
  {
    id: "mariadb",
    label: "MariaDB",
    image: "mariadb",
    defaultPort: 3306,
    defaultUser: "root",
    fallbackVersions: ["11.8", "11.4", "10.11", "10.6"],
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    image: "postgres",
    defaultPort: 5432,
    defaultUser: "postgres",
    fallbackVersions: ["18", "17", "16", "15"],
  },
];

export function getEngine(id: EngineId): EngineInfo {
  const engine = ENGINES.find((e) => e.id === id);
  if (!engine) throw new Error(`Unknown engine: ${id}`);
  return engine;
}

export interface EngineVersions {
  engine: EngineId;
  versions: string[];
  source: "docker-hub" | "fallback";
}
