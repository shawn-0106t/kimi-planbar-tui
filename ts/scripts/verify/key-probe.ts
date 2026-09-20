// What does OpenTUI actually report for Ctrl+C? The router quits on
// { name: "c", ctrl: true } (src/tui/app.ts), and the real-terminal round showed
// Ctrl+C doing nothing while `q` quit cleanly — so this probe logs the raw
// keypress object it receives, then exits. Run it from a console window:
//
//   cd ts && bun run scripts/verify/key-probe.ts
//
// It writes key-probe.log next to itself and quits on the first keypress (or
// after 20 s, whichever comes first), so a forgotten window cannot strand.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterRawMode, ensureRawMode } from "../../src/tui/console.ts";
import { createTuiRenderer } from "../../src/tui/renderer.ts";

const LOG = fileURLToPath(new URL("key-probe.log", import.meta.url));
const write = (entry: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`, "utf8");
};

appendFileSync(LOG, `--- run ${new Date().toISOString()}\n`, "utf8");
const renderer = await createTuiRenderer();
const restore = enterRawMode();
write({ ev: "start", width: renderer.width, height: renderer.height });

// Second channel: the raw bytes as they reach stdin. If Ctrl+C shows up here but
// not as a keypress, the console delivers it and OpenTUI's parser drops it; if
// it shows up nowhere, the key never leaves the terminal.
process.stdin.on("data", (chunk: Buffer) => {
  write({ ev: "stdin", hex: chunk.toString("hex"), text: JSON.stringify(chunk.toString("utf8")) });
});
process.stdin.setRawMode?.(true);
process.stdin.resume();

let done = false;
const finish = (why: string): void => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  renderer.destroy();
  restore();
  write({ ev: "exit", why });
  process.exit(0);
};
const timer = setTimeout(() => finish("timeout"), 20_000);

renderer.onKey((key) => {
  ensureRawMode();
  write({ ev: "key", ...key });
});
