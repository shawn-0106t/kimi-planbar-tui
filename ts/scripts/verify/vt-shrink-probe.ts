// Owned-console VT-mode probe for the REVIEW-RUST Minor 1 alignment (SPEC 20):
// the startup shrink must enable ENABLE_VIRTUAL_TERMINAL_PROCESSING on the
// output handle BEFORE writing the xterm window-size escape, and skip the
// escape channel entirely when the mode cannot be enabled (conhost would echo
// the escape as literal text).
//
// Run from a real terminal, or via a fresh console window:
//   cd ts && bun --use-system-ca run scripts/verify/vt-shrink-probe.ts [out.json] [--win32]
// --win32 additionally runs the Win32 shrink sequence (it resizes THIS console),
// mirroring test/console-probe.ts's opt-in --shrink. The VT mode bit is
// restored before exit so the probe leaves the console as it found it.

import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  attachedProcessCount,
  enableVtProcessing,
  shouldShrinkWindow,
  writeSizeEscapeIfVt,
} from "../../src/tui/shrink.ts";

const args = process.argv.slice(2);
const doWin32 = args.includes("--win32");
const outFile = args.find((a) => !a.startsWith("--"));
const report: Record<string, unknown> = { errors: [] };
const flush = (): Promise<unknown> => {
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  return outFile ? Bun.write(outFile, text) : Promise.resolve();
};

const k = dlopen("kernel32.dll", {
  GetStdHandle: { returns: FFIType.i64, args: [FFIType.u32] },
  GetConsoleMode: { returns: FFIType.i32, args: [FFIType.i64, FFIType.ptr] },
  SetConsoleMode: { returns: FFIType.i32, args: [FFIType.i64, FFIType.u32] },
  GetConsoleScreenBufferInfo: { returns: FFIType.i32, args: [FFIType.i64, FFIType.ptr] },
});
const STD_OUTPUT_HANDLE = 0xfffffff5; // (HANDLE)-11
const outH = Number(k.symbols.GetStdHandle(STD_OUTPUT_HANDLE));

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

const before = modeOf(outH);
Object.assign(report, {
  isTty: process.stdout.isTTY ?? false,
  attachedProcessCount: attachedProcessCount(),
  shouldShrink: shouldShrinkWindow(attachedProcessCount()),
  outputModeBefore: before,
});

const enabled = enableVtProcessing();
const after = modeOf(outH);
report.enableVtProcessing = enabled;
report.outputModeAfterEnable = after;
report.vtBitSetAfterEnable = after.startsWith("0x")
  ? (Number.parseInt(after, 16) & 0x0004) !== 0
  : null;

// The real writer (process.stdout), as shrinkOwnedConsole would drive it.
report.writeSizeEscapeIfVt = writeSizeEscapeIfVt((s) => process.stdout.write(s));

if (doWin32) {
  const { shrinkViaWin32 } = await import("../../src/tui/shrink.ts");
  report.shrinkViaWin32Returned = shrinkViaWin32(72, 13);
  report.sizeAfterShrink = sizeOf();
}

// Restore the original output mode so the probe is side-effect free.
const beforeNum = before.startsWith("0x") ? Number.parseInt(before, 16) : null;
report.modeRestored =
  beforeNum === null ? null : k.symbols.SetConsoleMode(outH, beforeNum) !== 0;

await flush();
process.exit(0);
