// Runs the cross-edition self-check diff (test/parity/diff.ts). The wrapper
// exists so the parity runner itself also gets --use-system-ca (ESET-style
// local TLS re-signing breaks Node's bundled Mozilla CA store; SPEC 17.2).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const diff = fileURLToPath(new URL("../test/parity/diff.ts", import.meta.url));
const proc = spawnSync(process.execPath, ["--use-system-ca", diff, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(proc.status ?? 1);
