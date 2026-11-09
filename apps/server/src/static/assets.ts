import { statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { Handler } from "hono";

/** Maps a URL pathname (e.g. "/assets/app.js") to a readable file path, or null. */
export interface AssetSource {
  resolve(pathname: string): string | null;
}

/** Serves files from a directory on disk (running from source). */
export function diskAssetSource(rootDir: string): AssetSource {
  const root = resolve(rootDir);
  return {
    resolve(pathname) {
      const filePath = resolve(root, `.${pathname}`);
      if (!filePath.startsWith(root + sep)) return null;
      return statSync(filePath, { throwIfNoEntry: false })?.isFile() ? filePath : null;
    },
  };
}

/** Serves only files listed in a manifest generated at compile time (single binary). */
export function embeddedAssetSource(manifest: Record<string, string>): AssetSource {
  const files = new Map(Object.entries(manifest));
  return { resolve: (pathname) => files.get(pathname) ?? null };
}

export function staticHandler(source: AssetSource): Handler {
  return (c) => {
    const pathname = decodePathname(new URL(c.req.url).pathname);
    if (pathname === null) return c.notFound();

    const requested = pathname === "/" ? "/index.html" : pathname;
    const filePath = source.resolve(requested);
    if (filePath) {
      return fileResponse(filePath, requested.startsWith("/assets/"));
    }

    // Paths without an extension are client-side routes handled by the SPA.
    const index = extname(requested) === "" ? source.resolve("/index.html") : null;
    return index ? fileResponse(index, false) : c.notFound();
  };
}

function fileResponse(filePath: string, immutable: boolean): Response {
  return new Response(Bun.file(filePath), {
    headers: {
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
