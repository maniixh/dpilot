import { type EngineId, type EngineVersions, getEngine } from "@dpilot/shared";
import { z } from "zod";

export interface HttpGetResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type HttpGet = (url: string) => Promise<HttpGetResponse>;

export interface VersionSource {
  versions(engine: EngineId): Promise<EngineVersions>;
}

export interface DockerHubVersionsOptions {
  get: HttpGet;
  now: () => number;
}

const HUB_TTL_MS = 60 * 60_000;
const FALLBACK_TTL_MS = 5 * 60_000;
const MAX_VERSIONS = 40;
const NUMERIC_TAG = /^\d+(\.\d+){0,2}$/;

const tagsResponseSchema = z.object({
  results: z.array(z.object({ name: z.string() })),
});

/**
 * Numeric tags only (no variants like `-alpine`), newest first.
 * A floating tag such as `18` sorts before the `18.x` tags it tracks.
 */
export function pickVersions(tags: readonly string[]): string[] {
  const unique = [...new Set(tags.filter((tag) => NUMERIC_TAG.test(tag)))];
  return unique.sort(compareVersionsDesc).slice(0, MAX_VERSIONS);
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return y - x;
  }
  return 0;
}

interface CacheEntry {
  expiresAt: number;
  value: Promise<EngineVersions>;
}

/** Official image tags from Docker Hub, falling back to the built-in catalog list. */
export function createDockerHubVersions(options: DockerHubVersionsOptions): VersionSource {
  const cache = new Map<EngineId, CacheEntry>();

  async function load(engine: EngineId): Promise<EngineVersions> {
    const { image, fallbackVersions } = getEngine(engine);
    const url = `https://hub.docker.com/v2/repositories/library/${image}/tags?page_size=100&ordering=last_updated`;
    try {
      const res = await options.get(url);
      if (!res.ok) throw new Error(`Docker Hub responded with HTTP ${res.status}`);
      const body = tagsResponseSchema.parse(await res.json());
      const versions = pickVersions(body.results.map((r) => r.name));
      if (versions.length > 0) {
        cache.set(engine, {
          expiresAt: options.now() + HUB_TTL_MS,
          value: Promise.resolve({ engine, versions, source: "docker-hub" }),
        });
        return { engine, versions, source: "docker-hub" };
      }
    } catch {
      // Offline or Hub changed: the catalog list keeps the create form usable.
    }
    const fallback: EngineVersions = {
      engine,
      versions: [...fallbackVersions],
      source: "fallback",
    };
    cache.set(engine, {
      expiresAt: options.now() + FALLBACK_TTL_MS,
      value: Promise.resolve(fallback),
    });
    return fallback;
  }

  return {
    versions(engine) {
      const cached = cache.get(engine);
      if (cached && cached.expiresAt > options.now()) return cached.value;
      const value = load(engine);
      cache.set(engine, { expiresAt: Number.POSITIVE_INFINITY, value });
      return value;
    },
  };
}
