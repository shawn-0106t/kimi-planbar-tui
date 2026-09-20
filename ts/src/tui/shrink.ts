// Minimal-window launch (SPEC 20), the TS counterpart of
// rust/src/app.rs::resize_owned_console.
//
// The guard must never touch a console shared with a user's shell. Rust reads
// `GetConsoleProcessList` and shrinks only when exactly one process is
// attached (a double-click / fresh-window launch). That Win32 call is
// reachable through bun:ffi, so the TS edition uses the same guard and keeps
// the behaviour identical; only when the FFI is unavailable (non-Windows, a
// stripped kernel32, a future Bun) does it fall back to the terminal
// environment-variable heuristic from TS-EDITION-PLAN §4 M3.
//
// Two best-effort shrink channels, both silent on failure, as in Rust:
//  (a) the xterm window-size escape `ESC [ 8 ; rows ; cols t` — Windows
//      Terminal 1.22+ (and conhost ignores it harmlessly);
//  (b) the conhost Win32 sequence: shrink the viewport to 1x1, set the screen
//      buffer to 72x13, then fit the viewport. COORD and SMALL_RECT are
//      passed by value, packed into an integer register per the x64 ABI.

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
  SetConsoleWindowInfo: (handle: number, absolute: number, rect: bigint) => number;
  SetConsoleScreenBufferSize: (handle: number, size: number) => number;
}

// The import itself is portable (bun:ffi resolves on any host); only the
// kernel32 dlopen below is Windows-only, and its failure degrades to the
// heuristic instead of throwing.
const lib = (() => {
  try {
    const d = dlopen("kernel32.dll", {
      GetStdHandle: { returns: FFIType.i64, args: [FFIType.u32] },
      GetConsoleProcessList: { returns: FFIType.u32, args: [FFIType.ptr, FFIType.u32] },
      SetConsoleWindowInfo: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32, FFIType.u64] },
      SetConsoleScreenBufferSize: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32] },
    });
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

const packSmallRect = (left: number, top: number, right: number, bottom: number): bigint =>
  (BigInt(left & 0xffff) |
    (BigInt(right & 0xffff) << 32n) |
    (BigInt(bottom & 0xffff) << 48n) |
    (BigInt(top & 0xffff) << 16n)) &
  0xffffffffffffffffn;

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
    // first (1x1), resize the buffer, then fit the viewport to 72x13.
    lib.symbols.SetConsoleWindowInfo(out, 1, packSmallRect(0, 0, 0, 0));
    lib.symbols.SetConsoleScreenBufferSize(out, packCoord(cols, rows));
    lib.symbols.SetConsoleWindowInfo(out, 1, packSmallRect(0, 0, cols - 1, rows - 1));
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
