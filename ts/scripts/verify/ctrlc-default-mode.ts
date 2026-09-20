// Does clearing ENABLE_PROCESSED_INPUT itself kill Ctrl+C? This probe touches
// nothing: no renderer, no console-mode FFI, so the console keeps its default
// cooked mode (PROCESSED_INPUT set). It logs raw stdin bytes and a SIGINT
// notice, and exits on SIGINT.
//
//   cd ts && bun run scripts/verify/ctrlc-default-mode.ts
//
// Ctrl+C here vs. in key-probe.ts separates "the app's raw mode swallowed the
// key" from "Windows Terminal never delivers Ctrl+C to this console at all".
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOG = fileURLToPath(new URL("ctrlc-probe.log", import.meta.url));
const write = (entry: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`, "utf8");
};

process.on("SIGINT", () => {
  write({ ev: "sigint" });
  process.exit(0);
});
process.on("SIGBREAK", () => write({ ev: "sigbreak" }));

write({ ev: "start", pid: process.pid, stdinIsTTY: process.stdin.isTTY === true });
process.stdin.on("data", (chunk: Buffer) => {
  write({ ev: "stdin", hex: chunk.toString("hex") });
});
process.stdin.setRawMode?.(true);
process.stdin.resume();

setTimeout(() => {
  write({ ev: "exit", why: "timeout" });
  process.exit(0);
}, 25_000);
