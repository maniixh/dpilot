import pkg from "../package.json";
import { runCli } from "./cli/run.ts";
import { webAssets } from "./generated/web-assets.ts";
import { embeddedAssetSource } from "./static/assets.ts";

const exitCode = runCli({
  argv: Bun.argv.slice(2),
  version: pkg.version,
  assets: embeddedAssetSource(webAssets),
  devTokenPath: null,
});

if (exitCode !== null) process.exit(exitCode);
