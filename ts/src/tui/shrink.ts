// Minimal-window launch (SPEC 20), the TS counterpart of
// rust/src/app.rs::resize_owned_console.
//
// The guard must never touch a console shared with a user's shell. Rust reads
// `GetConsoleProcessList` and shrinks only when exactly one process is
// attached (a double-click / fresh-window launch). That Win32 call is
// reachable through bun:ffi, so the TS edition uses the same guard and keeps
// the behaviour identical; only when the FFI is unavailable (non-Windows, a
// stripped kernel32, a future Bun) does it fall back to the terminal
// environment-variable heuristic (registered in SPEC §22.6).
//
// Two best-effort shrink channels, both silent on failure, as in Rust:
//  (a) the xterm window-size escape `ESC [ 8 ; rows ; cols t` — Windows
//      Terminal 1.22+ (and conhost ignores it harmlessly);
//  (b) the conhost Win32 sequence: shrink the viewport to 1x1, set the screen
//      buffer to 72x13, then fit the viewport. `SetConsoleScreenBufferSize`
//      takes COORD by value (4 bytes travel in a register per the x64 ABI),
//      but `SetConsoleWindowInfo` takes a `const SMALL_RECT *` — the struct
//      must live in a buffer and be passed by pointer (2026-09-25: the old
//      by-value packing fed struct bits in as the pointer itself and
//      segfaulted at address 0x0 on every owned-console launch, HANDOFF.md).

import { dlopen, FFIType, ptr } from "bun:ffi";

export const MIN_WIN_COLS = 72;
export const MIN_WIN_ROWS = 13;

const STD_OUTPUT_HANDLE = 0xfffffff5; // (HANDLE)-11

/** Env vars an already-running terminal session exports; their presence means
 *  this console belongs to somebody else. */
const SHARED_CONSOLE_VARS: readonly string[] = [
  "WT_SESSION", // Windows Terminal
  "TERM_PROGRAM", // VS Code / iTerm / Hyper
  "TERM", // any POSIX-ish shell wrapper
  "ConEmuPID", // ConEmu / Cmder / Total Commander
  "MSYSTEM", // Git Bash / MSYS2
  "TERMINUS_SUBLIME",
];

interface ConsoleFns {
  GetStdHandle: (n: number) => number;
  GetConsoleProcessList: (list: unknown, max: number) => number;
  SetConsoleWindowInfo: (handle: number, absolute: number, rect: unknown) => number;
  SetConsoleScreenBufferSize: (handle: number, size: number) => number;
}

/** The dlopen declaration table, exported so the regression test can pin the
 *  argument kinds: re-typing SetConsoleWindowInfo's third argument as a
 *  by-value u64 is exactly how the 2026-09-25 segfault happened (HANDOFF.md
 *  §2) — SMALL_RECT travels as `const SMALL_RECT *`, i.e. FFIType.ptr. */
export const consoleFnsDeclaration = {
  GetStdHandle: { returns: FFIType.i64, args: [FFIType.u32] },
  GetConsoleProcessList: { returns: FFIType.u32, args: [FFIType.ptr, FFIType.u32] },
  SetConsoleWindowInfo: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32, FFIType.ptr] },
  SetConsoleScreenBufferSize: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32] },
};

// The import itself is portable (bun:ffi resolves on any host); only the
// kernel32 dlopen below is Windows-only, and its failure degrades to the
// heuristic instead of throwing.
const lib = (() => {
  try {
    const d = dlopen("kernel32.dll", consoleFnsDeclaration);
    const symbols = d.symbols as unknown as ConsoleFns;
    return { symbols, ptr };
  } catch {
    return null;
  }
})();

/** Processes attached to this console; null when it cannot be asked. */
export function attachedProcessCount(): number | null {
  if (lib === null) return null;
  try {
    const buf = Buffer.alloc(8 * 4);
    const n = lib.symbols.GetConsoleProcessList(lib.ptr(buf), 8);
    return n === 0 ? null : n;
  } catch {
    return null;
  }
}

export function looksSharedConsole(env: NodeJS.ProcessEnv = process.env): boolean {
  return SHARED_CONSOLE_VARS.some((name) => {
    const value = env[name];
    return value !== undefined && value !== "";
  });
}

/** SPEC 20 guard, as a pure decision so both branches are testable. */
export function shouldShrinkWindow(
  count: number | null,
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  if (!isTty) return false;
  return count === null ? !looksSharedConsole(env) : count === 1;
}

/** SMALL_RECT as kernel32 wants it: four little-endian i16 (left, top,
 *  right, bottom) in an 8-byte buffer, passed by pointer. Exported for the
 *  byte-layout regression test. */
export const packSmallRect = (left: number, top: number, right: number, bottom: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeInt16LE(left, 0);
  b.writeInt16LE(top, 2);
  b.writeInt16LE(right, 4);
  b.writeInt16LE(bottom, 6);
  return b;
};

const packCoord = (x: number, y: number): number => ((y & 0xffff) << 16) | (x & 0xffff);

/** The xterm window-size escape, `ESC [ 8 ; rows ; cols t` (channel a). */
export function windowSizeEscape(cols: number, rows: number): string {
  return `\x1b[8;${rows};${cols}t`;
}

/** Channel (b): the conhost Win32 sequence. Split out from
 *  shrinkOwnedConsole() so tests never resize the terminal they run in. */
export function shrinkViaWin32(cols: number, rows: number): boolean {
  if (lib === null) return false;
  try {
    // i64 return → bigint from Bun; handles fit well below 2^53.
    const out = Number(lib.symbols.GetStdHandle(STD_OUTPUT_HANDLE));
    if (out === 0 || out === -1) return false;
    // Buffer must never be smaller than the viewport, so shrink the viewport
    // first (1x1), resize the buffer, then fit the viewport to 72x13. The
    // SMALL_RECT buffers are held in locals so the memory outlives each FFI
    // call by construction, not by inlining luck.
    const shrinkRect = packSmallRect(0, 0, 0, 0);
    const fitRect = packSmallRect(0, 0, cols - 1, rows - 1);
    lib.symbols.SetConsoleWindowInfo(out, 1, ptr(shrinkRect));
    lib.symbols.SetConsoleScreenBufferSize(out, packCoord(cols, rows));
    lib.symbols.SetConsoleWindowInfo(out, 1, ptr(fitRect));
    return true;
  } catch {
    // best effort, exactly like the Rust `let _ =` calls
    return false;
  }
}

/** Shrink an owned console to 72x13 through both channels. */
export function shrinkOwnedConsole(
  cols: number = MIN_WIN_COLS,
  rows: number = MIN_WIN_ROWS,
  write: (chunk: string) => unknown = (s) => process.stdout.write(s),
): boolean {
  let touched = false;
  try {
    // Windows Terminal 1.22+ honours this; conhost ignores it without harm.
    write(windowSizeEscape(cols, rows));
    touched = true;
  } catch {
    // a closed stdout just means channel (a) is unavailable
  }
  return shrinkViaWin32(cols, rows) || touched;
}

/** Startup entry point: guard, then shrink (SPEC 20, before terminal init). */
export function shrinkOwnedConsoleIfOwned(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stdout.isTTY === true,
): boolean {
  if (!shouldShrinkWindow(attachedProcessCount(), env, isTty)) return false;
  return shrinkOwnedConsole();
}
