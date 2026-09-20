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

  test("a failure after raw mode still switches raw back off", () => {
    const writes: string[] = [];
    const rawCalls: boolean[] = [];
    const stdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (s: string) => (writes.push(s), true),
      on: () => stdout,
    };
    const stdin = {
      isTTY: true,
      setRawMode: (mode: boolean) => (rawCalls.push(mode), stdin),
      // Any listener wiring fails AFTER raw mode went on: the catch must undo
      // raw mode as well as leave the alternate screen.
      on: (): never => {
        throw new Error("listener wiring failed");
      },
      removeListener: () => stdin,
      listenerCount: () => 0,
    };
    let caught: unknown = null;
    try {
      createTerminal(stdout as never, stdin as never);
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof Error).toBe(true);
    expect((caught as Error).message).toBe("listener wiring failed");
    expect(rawCalls).toEqual([true, false]);
    expect(writes).toEqual([TERMINAL_ENTER, TERMINAL_LEAVE]);
  });
});

describe("destroy (SPEC 20)", () => {
  const livePair = () => {
    const writes: string[] = [];
    const rawCalls: boolean[] = [];
    const stdout = {
      isTTY: true,
      columns: 80,
      rows: 24,
      write: (s: string) => (writes.push(s), true),
      on: () => stdout,
    };
    const stdin = {
      isTTY: true,
      setRawMode: (mode: boolean) => (rawCalls.push(mode), stdin),
      on: () => stdin,
      removeListener: () => stdin,
      listenerCount: () => 0,
      pause: () => stdin,
      resume: () => stdin,
    };
    return { stdout, stdin, writes, rawCalls };
  };

  test("destroy restores raw mode, writes LEAVE once and is idempotent", () => {
    const { stdout, stdin, writes, rawCalls } = livePair();
    const terminal = createTerminal(stdout as never, stdin as never);
    terminal.destroy();
    terminal.destroy();
    expect(rawCalls).toEqual([true, false]);
    expect(writes).toEqual([TERMINAL_ENTER, TERMINAL_LEAVE]);
  });

  test("a throwing final write (EPIPE) does not escape destroy", () => {
    const { stdout, stdin, rawCalls } = livePair();
    stdout.write = (s: string) => {
      if (s === TERMINAL_LEAVE) throw new Error("write EPIPE");
      return true;
    };
    const terminal = createTerminal(stdout as never, stdin as never);
    expect(() => terminal.destroy()).not.toThrow();
    expect(rawCalls).toEqual([true, false]);
  });
});
