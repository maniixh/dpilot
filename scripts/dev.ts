/**
 * Runs the server and the Vite dev server together.
 *
 * `bun run --filter`/`--parallel` gives each script its own console on Windows,
 * so Ctrl+C never reaches them and they outlive the terminal. Spawning them here
 * keeps them in this console, and any exit stops the whole group.
 */
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

const root = join(import.meta.dir, "..");
const webDir = join(root, "apps", "web");
const viteBin = join(dirname(Bun.resolveSync("vite/package.json", webDir)), "bin", "vite.js");

const children: Subprocess[] = [
  Bun.spawn([process.execPath, "--watch", "src/main.ts", "--dev"], {
    cwd: join(root, "apps", "server"),
    stdio: ["inherit", "inherit", "inherit"],
  }),
  Bun.spawn([process.execPath, viteBin], {
    cwd: webDir,
    stdio: ["inherit", "inherit", "inherit"],
  }),
];

let stopping = false;

/** `bun --watch` runs the app in a grandchild, so stop whole process trees. */
function stopAll(exitCode: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (process.platform === "win32") {
      Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/t", "/f"], {
        stdio: ["ignore", "ignore", "ignore"],
      });
    } else {
      child.kill("SIGTERM");
    }
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => stopAll(130));
process.on("SIGTERM", () => stopAll(143));

const first = await Promise.race(children.map((child) => child.exited));
stopAll(first);
