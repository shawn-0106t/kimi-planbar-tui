// Windows console raw mode via bun:ffi — the TS stand-in for crossterm's
// enable_raw_mode/disable_raw_mode (SPEC 20 terminal discipline).
//
// Why this exists: Bun 1.4.2's `process.stdin.setRawMode()` is a no-op for the
// OS console mode on Windows (FFI probe: ENABLE_ECHO_INPUT stays set before and
// after the call). OpenTUI's setupTerminal guards its raw call behind
// `if (stdin.setRawMode)`, so on Bun/Windows the console is left cooked and
// conhost echoes every keypress at the cursor ("Resets in 2r'r'r" in the live
// M2 check). Worse, Bun flips the console back to cooked each time it reads a
// key, so setting raw once is not enough — the app re-asserts it on every input
// event via ensureRawMode(), keeping the echo bit off whenever a key arrives.
//
// Raw mode = clear ENABLE_LINE_INPUT (0x2) + ENABLE_ECHO_INPUT (0x4), ensure
// ENABLE_WINDOW_INPUT (0x8). All FFI failures are swallowed (SPEC 20).

import { dlopen, FFIType, ptr } from "bun:ffi";

// (HANDLE)-10 is 0xfffffff6; 0xfffffff5 is the *output* handle (-11), and
// SetConsoleMode on an output handle rejects everything but
// ENABLE_PROTECTED_CONSOLE_PROCESS, so pointing here at the wrong constant
// silently disabled the raw-mode call.
const STD_INPUT_HANDLE = 0xfffffff6; // (HANDLE)-10
const ENABLE_LINE_INPUT = 0x0002;
const ENABLE_ECHO_INPUT = 0x0004;
const ENABLE_WINDOW_INPUT = 0x0008;

interface ConsoleFns {
  GetStdHandle: (n: number) => number;
  GetConsoleMode: (h: number, mode: unknown) => number;
  SetConsoleMode: (h: number, mode: number) => number;
}

const lib = (() => {
  try {
    const d = dlopen("kernel32.dll", {
      GetStdHandle: { returns: FFIType.i64, args: [FFIType.u32] },
      GetConsoleMode: { returns: FFIType.u8, args: [FFIType.i64, FFIType.ptr] },
      SetConsoleMode: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32] },
    });
    return d.symbols as unknown as ConsoleFns;
  } catch {
    return null;
  }
})();

let handle = 0;
let buf: Buffer | null = null;
let rawMode = -1;
let originalMode = -1;

function readMode(): number {
  if (lib === null || buf === null) return -1;
  return lib.GetConsoleMode(handle, ptr(buf)) ? buf.readUInt32LE(0) : -1;
}

/** Enter raw mode; returns a restore fn (no-op if FFI or a call fails). */
export function enterRawMode(): () => void {
  if (lib === null) return () => {};
  try {
    // GetStdHandle is declared i64, so Bun hands back a bigint; handle values
    // fit far below 2^53 and the rest of this module compares them as numbers.
    handle = Number(lib.GetStdHandle(STD_INPUT_HANDLE));
    buf = Buffer.alloc(4);
    originalMode = readMode();
    if (originalMode === -1) return () => {};
    rawMode = (originalMode & ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT)) | ENABLE_WINDOW_INPUT;
    if (!lib.SetConsoleMode(handle, rawMode)) return () => {};
    return () => {
      try {
        lib?.SetConsoleMode(handle, originalMode);
      } catch {
        // best effort, like the Rust panic-hook restore
      }
    };
  } catch {
    return () => {};
  }
}

/** Re-assert raw mode if the console drifted back to cooked (Bun flips the
 *  echo bit on every stdin read). Cheap: one GetConsoleMode, one Set only on
 *  drift. Safe to call before enterRawMode or after a failed one. */
export function ensureRawMode(): void {
  if (lib === null || rawMode === -1) return;
  try {
    if (readMode() !== rawMode) lib.SetConsoleMode(handle, rawMode);
  } catch {
    // swallow
  }
}
