// Runs the node:test suite with a pinned timezone. The Rust-oracle goldens
// embed DateTime<Local> rendered on a +08:00 machine, so tests must see
// TZ=Asia/Shanghai — and npm scripts on Windows go through cmd.exe, which has
// no `TZ=... command` prefix syntax, hence this wrapper. Explicit file paths
// are passed so test discovery does not depend on runner glob defaults.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.TZ = "Asia/Shanghai";

const testDir = fileURLToPath(new URL("../test", import.meta.url));
const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(testDir, name));

const proc = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
  env: process.env,
});
process.exit(proc.status ?? 1);
