// Startup window shrink (SPEC 20): the ownership guard and the escape text.
// Only the decision is tested here — shrinkViaWin32() would resize whatever
// console the test runner is attached to, so it is exercised on a dedicated
// fresh console instead (see SPEC §22.6).

import { describe, expect, test } from "bun:test";
import {
  looksSharedConsole,
  MIN_WIN_COLS,
  MIN_WIN_ROWS,
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
});
