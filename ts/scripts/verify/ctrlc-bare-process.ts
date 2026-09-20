// Minimal control test: a bare Bun process that installs NO signal handler and
// reads NO stdin. If Ctrl+C kills it, the console control event does reach the
// process and the swallowing happens in the JS/reader layer; if it runs to the
// timeout, the event never arrives at the process at all.
//
//   cd ts && bun run scripts/verify/ctrlc-bare-process.ts
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOG = fileURLToPath(new URL("ctrlc-bare.log", import.meta.url));
const write = (entry: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`, "utf8");
};

write({ ev: "start", pid: process.pid });
setTimeout(() => {
  write({ ev: "exit", why: "timeout" });
  process.exit(0);
}, 25_000);
