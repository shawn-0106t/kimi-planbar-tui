// Terminal lifecycle pins (SPEC 20): the failure path of createTerminal must
// not strand the console in the alternate screen — if any step after the
// ENTER sequence throws, the LEAVE sequence goes out before the error does.

import { describe, expect, test } from "./bun-shim.ts";
import { createTerminal, TERMINAL_ENTER, TERMINAL_LEAVE } from "../src/tui/terminal.ts";

describe("createTerminal failure path (SPEC 20)", () => {
  test("a setRawMode throw is preceded by the LEAVE sequence", () => {
    const writes: string[] = [];
    const stdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (s: string) => (writes.push(s), true),
      on: () => stdout,
    };
    const stdin = {
      isTTY: true,
      setRawMode: () => {
        throw new Error("no raw mode here");
      },
      on: () => stdin,
      removeListener: () => stdin,
    };
    let caught: unknown = null;
    try {
      // The fake streams are structurally sufficient: setRawMode throws
      // before any readline/stdin wiring is reached.
      createTerminal(stdout as never, stdin as never);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error).toBe(true);
    expect((caught as Error).message).toBe("no raw mode here");
    expect(writes).toEqual([TERMINAL_ENTER, TERMINAL_LEAVE]);
  });
});
