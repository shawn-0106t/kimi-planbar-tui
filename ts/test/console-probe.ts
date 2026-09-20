// Console environment probe for the SPEC 20 checks that cannot run under a
// piped test runner: raw mode, console ownership, and the 72x13 shrink. Run it
// from a REAL terminal (Windows Terminal or a double-clicked conhost window):
//
//   cd ts && bun test/console-probe.ts                # read-only report
//   cd ts && bun test/console-probe.ts --shrink      # also resizes THIS console
//   cd ts && bun test/console-probe.ts out.json      # also writes the JSON
//
// --shrink is opt-in because it calls SetConsoleWindowInfo on the console it is
// attached to; without it the probe only reports what the app would decide.
// The `--shrink` path is what proves the conhost channel of
// ts/src/tui/shrink.ts (COORD / SMALL_RECT passed by value through bun:ffi).

import { dlopen, FFIType, ptr } from "bun:ffi";
import { attachedProcessCount, shouldShrinkWindow, shrinkViaWin32, windowSizeEscape } from "../src/tui/shrink.ts";
import { enterRawMode, ensureRawMode } from "../src/tui/console.ts";

const args = process.argv.slice(2);
const doShrink = args.includes("--shrink");
const outFile = args.find((a) => !a.startsWith("--"));
const report: Record<string, unknown> = { errors: [] };
const flush = (): Promise<unknown> => {
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  return outFile ? Bun.write(outFile, text) : Promise.resolve();
};
process.on("uncaughtException", (e) => {
  (report.errors as string[]).push(`uncaught: ${String(e)}`);
  void flush();
  process.exit(1);
});

const k = dlopen("kernel32.dll", {
  GetStdHandle: { returns: FFIType.i64, args: [FFIType.u32] },
  GetConsoleMode: { returns: FFIType.u8, args: [FFIType.i64, FFIType.ptr] },
  GetConsoleScreenBufferInfo: { returns: FFIType.u8, args: [FFIType.i64, FFIType.ptr] },
});
const STD_INPUT_HANDLE = 0xfffffff6; // (HANDLE)-10
const STD_OUTPUT_HANDLE = 0xfffffff5; // (HANDLE)-11
const inH = Number(k.symbols.GetStdHandle(STD_INPUT_HANDLE));
const outH = Number(k.symbols.GetStdHandle(STD_OUTPUT_HANDLE));

/** Raw mode is (base & ~(LINE|ECHO)) | WINDOW_INPUT; echo off means bit 0x4 clear. */
const modeOf = (h: number): string => {
  const b = Buffer.alloc(4);
  return k.symbols.GetConsoleMode(h, ptr(b)) ? `0x${b.readUInt32LE(0).toString(16)}` : "error";
};
const sizeOf = (): string => {
  const b = Buffer.alloc(22);
  if (!k.symbols.GetConsoleScreenBufferInfo(outH, ptr(b))) return "error";
  const win = [b.readInt16LE(10), b.readInt16LE(12), b.readInt16LE(14), b.readInt16LE(16)];
  return `buffer=${b.readInt16LE(0)}x${b.readInt16LE(2)} window=${win[2] - win[0] + 1}x${win[3] - win[1] + 1}`;
};

const modes: Record<string, string> = {};
Object.assign(report, {
  argv: args,
  isTty: { stdin: process.stdin.isTTY ?? false, stdout: process.stdout.isTTY ?? false },
  terminalEnv: {
    WT_SESSION: process.env.WT_SESSION ?? null,
    TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
    TERM: process.env.TERM ?? null,
    MSYSTEM: process.env.MSYSTEM ?? null,
    ConEmuPID: process.env.ConEmuPID ?? null,
  },
  attachedProcessCount: attachedProcessCount(),
  handles: { input: inH, output: outH },
  escape: windowSizeEscape(72, 13),
});
modes.inputBefore = modeOf(inH);
modes.outputBefore = modeOf(outH);
report.modes = modes;
report.sizeBefore = sizeOf();
flush();

const restore = enterRawMode();
modes.inputAfterEnterRaw = modeOf(inH);
modes.outputAfterEnterRaw = modeOf(outH);
ensureRawMode();
modes.inputAfterEnsure = modeOf(inH);
restore();
modes.inputAfterRestore = modeOf(inH);

report.shouldShrink = shouldShrinkWindow(attachedProcessCount());
if (doShrink) {
  report.shrinkViaWin32Returned = shrinkViaWin32(72, 13);
  report.sizeAfterShrink = sizeOf();
}
flush();

// Does OpenTUI's own setupTerminal put the console into raw mode? (M2 assumed
// it does not on Bun/Windows; this is the measurement behind SPEC §22.5.)
try {
  const { createCliRenderer } = await import("@opentui/core");
  modes.inputBeforeOpentui = modeOf(inH);
  const r = await createCliRenderer({ exitOnCtrlC: false });
  report.opentui = { width: r.width, height: r.height };
  modes.inputAfterOpentui = modeOf(inH);
  r.destroy();
  modes.inputAfterOpentuiDestroy = modeOf(inH);
} catch (e) {
  (report.errors as string[]).push(`opentui: ${String(e)}`);
}
report.sizeFinal = sizeOf();
await flush();
process.exit(0);
