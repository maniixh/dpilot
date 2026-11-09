import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { renderAssetModule } from "./asset-module.ts";

const serverDir = resolve(import.meta.dir, "..");
const webDist = resolve(serverDir, "..", "web", "dist");
const generatedDir = join(serverDir, "src", "generated");
const outfile = resolve(serverDir, "..", "..", "dist", "dpilot");

const files = readdirSync(webDist, { recursive: true, encoding: "utf8" }).filter((file) =>
  statSync(join(webDist, file)).isFile(),
);
const importBase = relative(generatedDir, webDist).replaceAll("\\", "/");

mkdirSync(generatedDir, { recursive: true });
writeFileSync(join(generatedDir, "web-assets.ts"), renderAssetModule(files, importBase));
console.log(`Embedding ${files.length} web files`);

const build = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "--compile",
    "--minify",
    join(serverDir, "src", "main-binary.ts"),
    "--outfile",
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(build.exitCode);
