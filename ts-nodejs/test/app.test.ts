// App-level pins that do not need a TTY: the fresh-window shrink heuristic
// (SPEC 20 / §22.6) — the one piece of app.ts
// that is pure enough to unit-test by injecting env and a write sink.

import { describe, expect, test } from "./bun-shim.ts";
import { shrinkFreshWindow } from "../src/tui/app.ts";

const sink = (isTTY: boolean): { writes: string[]; out: { isTTY: boolean; write(s: string): boolean } } => {
  const writes: string[] = [];
  return { writes, out: { isTTY, write: (s: string) => (writes.push(s) > 0) } };
};

describe("shrinkFreshWindow (SPEC 20: never resize a shared console)", () => {
  test("a fresh double-click window (no terminal markers) gets 72x13", () => {
    const { writes, out } = sink(true);
    shrinkFreshWindow({}, out);
    expect(writes).toEqual(["\x1b[8;13;72t"]);
  });

  test("any terminal marker suppresses the resize", () => {
    for (const marker of ["WT_SESSION", "TERM_PROGRAM", "ConEmuPID"]) {
      const { writes, out } = sink(true);
      shrinkFreshWindow({ [marker]: "1" }, out);
      expect(writes).toEqual([]);
    }
  });

  test("non-TTY stdout (self-checks, pipes) is never touched", () => {
    const { writes, out } = sink(false);
    shrinkFreshWindow({}, out);
    expect(writes).toEqual([]);
  });

  test("a throwing write is swallowed silently", () => {
    shrinkFreshWindow({}, { isTTY: true, write: () => { throw new Error("nope"); } });
  });
});
