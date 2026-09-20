// Screen-layer pins (SPEC §22.5 — sanitize, hard clip, line diff, bottom-right cell):
// sanitization as the injection firewall, wcwidth hard clipping, windowBg
// padding, line-level diffing, first-frame clear, and the bottom-right cell
// scroll trap. Everything runs against an in-memory write sink — no TTY.

import { describe, expect, test } from "./bun-shim.ts";
import { hexToRgb, sanitize, sgrOpen, SGR_RESET } from "../src/tui/ansi.ts";
import { renderRow, Screen } from "../src/tui/screen.ts";
import { tline, tspan } from "../src/tui/line.ts";

const BG = "#112233";
const BG_SGR = "\x1b[48;2;17;34;51m";

describe("sanitize (plan §2.2 — the injection firewall)", () => {
  test("strips C0 controls, ESC, DEL and C1", () => {
    expect(sanitize("a\x00b\x07c\x1bd")).toBe("abcd");
    expect(sanitize("a\x7fb\x85c")).toBe("abc");
  });

  test("keeps plain text and wide characters intact", () => {
    expect(sanitize("Kimi 中文 █")).toBe("Kimi 中文 █");
  });

  test("an injected SGR sequence in a skill name cannot reach a frame", () => {
    const evil = tline([tspan("evil-\x1b[31mHACK\x1b[0m-skill")]);
    const out = renderRow(evil, 40, BG);
    expect(out).not.toContain("\x1b[31m");
    expect(out).toContain("evil-HACK-skill");
  });
});

describe("sgrOpen", () => {
  test("hexToRgb parses the SPEC 11.1 palette format only", () => {
    expect(hexToRgb("#1A88FF")).toEqual([26, 136, 255]);
    expect(hexToRgb("red")).toBeNull();
    expect(hexToRgb("#12345")).toBeNull();
  });

  test("opens with a reset, then truecolor fg/bg and attributes", () => {
    expect(sgrOpen({ fg: "#1A88FF", bold: true })).toBe(`${SGR_RESET}\x1b[38;2;26;136;255m\x1b[1m`);
    expect(sgrOpen({ bg: BG, underline: true })).toBe(`${SGR_RESET}${BG_SGR}\x1b[4m`);
    expect(sgrOpen({})).toBe(SGR_RESET);
  });
});

describe("renderRow (plan §2.4)", () => {
  test("hard-clips overflow instead of wrapping (SPEC 12.2)", () => {
    const out = renderRow(tline([tspan("abcdef")]), 3, BG);
    expect(out).toBe(`${SGR_RESET}abc${SGR_RESET}`);
  });

  test("clips by cell width: a wide char on the boundary is dropped, not split", () => {
    // "ab中" against width 3: '中' needs 2 cells with only 1 left -> dropped,
    // the last cell is a windowBg space.
    const out = renderRow(tline([tspan("ab中")]), 3, BG);
    expect(out).toBe(`${SGR_RESET}ab${SGR_RESET}${BG_SGR} ${SGR_RESET}`);
  });

  test("pads the right edge with a windowBg run", () => {
    const out = renderRow(tline([tspan("abc")]), 5, BG);
    expect(out).toBe(`${SGR_RESET}abc${SGR_RESET}${BG_SGR}  ${SGR_RESET}`);
  });

  test("span styles reach the wire", () => {
    const out = renderRow(tline([tspan("x", { fg: "#FF0000", bold: true })]), 1, BG);
    expect(out).toContain("\x1b[38;2;255;0;0m");
    expect(out).toContain("\x1b[1m");
  });
});

describe("Screen diff writer", () => {
  const sink = (): { writes: string[]; write: (s: string) => void } => {
    const writes: string[] = [];
    return { writes, write: (s) => writes.push(s) };
  };
  const frame3 = (rows: string[]): ReturnType<typeof tline>[] =>
    rows.map((r) => tline([tspan(r)]));

  test("the first frame clears the screen and homes the cursor", () => {
    const { writes, write } = sink();
    const screen = new Screen(10, 2, write);
    screen.writeFrame(frame3(["row0", "row1"]), BG);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("\x1b[2J\x1b[H");
    expect(writes[0]).toContain("\x1b[1;1H");
    expect(writes[0]).toContain("\x1b[2;1H");
  });

  test("frames are wrapped in DEC 2026 synchronized output", () => {
    const { writes, write } = sink();
    new Screen(10, 1, write).writeFrame(frame3(["x"]), BG);
    expect(writes[0]!.startsWith("\x1b[?2026h")).toBe(true);
    expect(writes[0]!.endsWith("\x1b[?2026l")).toBe(true);
  });

  test("only changed rows are rewritten", () => {
    const { writes, write } = sink();
    const screen = new Screen(10, 3, write);
    screen.writeFrame(frame3(["a", "b", "c"]), BG);
    screen.writeFrame(frame3(["a", "B", "c"]), BG);
    expect(writes.length).toBe(2);
    expect(writes[1]).toContain("\x1b[2;1H");
    expect(writes[1]).not.toContain("\x1b[1;1H");
    expect(writes[1]).not.toContain("\x1b[3;1H");
  });

  test("an identical frame writes nothing", () => {
    const { writes, write } = sink();
    const screen = new Screen(10, 2, write);
    screen.writeFrame(frame3(["a", "b"]), BG);
    screen.writeFrame(frame3(["a", "b"]), BG);
    expect(writes.length).toBe(1);
  });

  test("the bottom row never fills the last cell (plan §3 trap 1)", () => {
    const { writes, write } = sink();
    const screen = new Screen(5, 2, write);
    screen.writeFrame(frame3(["12345", "12345"]), BG);
    // Top row keeps all 5 cells; the bottom row is clipped to 4 + no filler.
    expect(writes[0]).toContain("12345");
    expect(writes[0]).toContain(`\x1b[2;1H${SGR_RESET}1234${SGR_RESET}`);
  });

  test("a shrinking frame clears the leftover rows", () => {
    const { writes, write } = sink();
    const screen = new Screen(10, 4, write);
    screen.writeFrame(frame3(["a", "b", "c", "d"]), BG);
    screen.writeFrame(frame3(["a", "b"]), BG);
    expect(writes[1]).toContain("\x1b[3;1H\x1b[2K");
    expect(writes[1]).toContain("\x1b[4;1H\x1b[2K");
  });

  test("setSize forces a full repaint", () => {
    const { writes, write } = sink();
    const screen = new Screen(10, 2, write);
    screen.writeFrame(frame3(["a", "b"]), BG);
    screen.setSize(20, 2);
    screen.writeFrame(frame3(["a", "b"]), BG);
    expect(writes[1]).toContain("\x1b[2J\x1b[H");
    expect(writes[1]).toContain("\x1b[1;1H");
  });
});
