// Startup window shrink (SPEC 20): the ownership guard and the escape text.
// Only the decision is tested here — shrinkViaWin32() would resize whatever
// console the test runner is attached to, so it is exercised on a dedicated
// fresh console instead (see SPEC §22.6).

import { FFIType } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import {
  consoleFnsDeclaration,
  looksSharedConsole,
  MIN_WIN_COLS,
  MIN_WIN_ROWS,
  packSmallRect,
  shouldShrinkWindow,
  windowSizeEscape,
} from "../src/tui/shrink.ts";

describe("console ownership guard (SPEC 20)", () => {
  test("the wireframe minimum matches the Rust constants", () => {
    expect([MIN_WIN_COLS, MIN_WIN_ROWS]).toEqual([72, 13]);
  });

  test("a single attached process means the console is ours", () => {
    expect(shouldShrinkWindow(1, {}, true)).toBe(true);
  });

  test("more than one attached process leaves the user's window alone", () => {
    for (const n of [2, 3, 8]) expect(shouldShrinkWindow(n, { WT_SESSION: "x" }, true)).toBe(false);
  });

  test("without the FFI answer the terminal env vars decide", () => {
    expect(shouldShrinkWindow(null, {}, true)).toBe(true); // a bare double-click console
    expect(shouldShrinkWindow(null, { WT_SESSION: "guid" }, true)).toBe(false);
    expect(shouldShrinkWindow(null, { TERM_PROGRAM: "vscode" }, true)).toBe(false);
    expect(shouldShrinkWindow(null, { MSYSTEM: "MINGW64" }, true)).toBe(false);
    expect(shouldShrinkWindow(null, { ConEmuPID: "1234" }, true)).toBe(false);
    expect(shouldShrinkWindow(null, { TERM: "xterm-256color" }, true)).toBe(false);
    // present but empty is not a terminal session
    expect(shouldShrinkWindow(null, { WT_SESSION: "" }, true)).toBe(true);
  });

  test("a non-TTY stdout never gets an escape written", () => {
    expect(shouldShrinkWindow(1, {}, false)).toBe(false);
    expect(shouldShrinkWindow(null, {}, false)).toBe(false);
  });

  test("the heuristic recognises an inherited environment", () => {
    expect(looksSharedConsole({})).toBe(false);
    expect(looksSharedConsole({ WT_SESSION: "g" })).toBe(true);
  });
});

describe("shrink channels (SPEC 20)", () => {
  test("the xterm escape is ESC [ 8 ; rows ; cols t", () => {
    expect(windowSizeEscape(MIN_WIN_COLS, MIN_WIN_ROWS)).toBe("\x1b[8;13;72t");
    expect(windowSizeEscape(100, 30)).toBe("\x1b[8;30;100t");
  });

  test("SMALL_RECT packs as a pointer target: 4 × i16 LE (left, top, right, bottom)", () => {
    // 2026-09-25 regression pin: SetConsoleWindowInfo takes `const SMALL_RECT *`.
    // The old by-value u64 packing fed struct bits in as the pointer itself and
    // segfaulted at 0x0 on every owned-console launch (HANDOFF.md §2).
    const b = packSmallRect(0, 0, 71, 12);
    expect(b.length).toBe(8);
    expect([b.readInt16LE(0), b.readInt16LE(2), b.readInt16LE(4), b.readInt16LE(6)]).toEqual([
      0, 0, 71, 12,
    ]);
    const one = packSmallRect(0, 0, 0, 0);
    expect(one.every((byte) => byte === 0)).toBe(true);
  });

  test("the FFI declaration keeps SMALL_RECT behind a pointer, COORD by value", () => {
    // Pins the declaration itself: the byte-layout test above cannot see a
    // re-typed args table, and reverting SetConsoleWindowInfo's third argument
    // to a by-value u64 is exactly the 2026-09-25 segfault (HANDOFF.md §2).
    expect(consoleFnsDeclaration.SetConsoleWindowInfo.args[2]).toBe(FFIType.ptr);
    expect(consoleFnsDeclaration.SetConsoleScreenBufferSize.args[1]).toBe(FFIType.u32);
  });
});
