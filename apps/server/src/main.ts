import { join } from "node:path";
import pkg from "../package.json";
import { runCli } from "./cli/run.ts";
import { diskAssetSource } from "./static/assets.ts";

const exitCode = runCli({
  argv: Bun.argv.slice(2),
  version: pkg.version,
  assets: diskAssetSource(join(import.meta.dir, "..", "..", "web", "dist")),
  devTokenPath: join(import.meta.dir, "..", ".dev-token"),
});

if (exitCode !== null) process.exit(exitCode);
