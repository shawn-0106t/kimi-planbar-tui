// Line-model cell width and clipping (SPEC 21.3, §22.5). M2
// only ever drew ASCII and Ambiguous glyphs, so `text.length` stood in for the
// cell count; the skills view brings real CJK, which ratatui counts as 2 cells.

import { describe, expect, test } from "bun:test";
import {
  charWidth,
  displayWidth,
  lineWidth,
  lineText,
  padLineToWidth,
  sanitize,
  tline,
  tspan,
} from "../src/tui/line.ts";

const BG = "#F3F4F6";

describe("display width (unicode-width stand-in)", () => {
  test("ASCII and the Ambiguous glyphs the palette uses are one cell", () => {
    expect(displayWidth("Kimi Skills")).toBe(11);
    // the S0 probe measured exactly these as 1 cell in OpenTUI and ratatui
    for (const g of ["█", "░", "·", "¥", "●", "↑", "→"]) expect(charWidth(g.codePointAt(0)!)).toBe(1);
  });

  test("CJK, fullwidth forms and Hangul are two cells", () => {
    expect(displayWidth("中文")).toBe(4);
    expect(displayWidth("，")).toBe(2); // U+FF0C fullwidth comma
    expect(displayWidth("가")).toBe(2); // Hangul syllable
    expect(displayWidth("a中b")).toBe(4);
  });

  test("combining marks and variation selectors take no cell", () => {
    expect(displayWidth("é")).toBe(1);
    expect(displayWidth("❤️")).toBe(1); // U+2764 is Ambiguous -> narrow, U+FE0F is zero
    expect(displayWidth("😀")).toBe(2); // emoji blocks are counted wide
  });
});

describe("padLineToWidth with wide runs (SPEC 21.3 truncation)", () => {
  test("a CJK line is padded to the full width in cells, not code units", () => {
    const line = tline([tspan("  中文", { fg: BG })]);
    const padded = padLineToWidth(line, 20, BG);
    expect(lineWidth(padded)).toBe(20);
    expect(lineText(padded)).toBe("  中文" + " ".repeat(14));
  });

  test("an over-long description clips at a cell boundary", () => {
    const line = tline([tspan("    一二三四五")]);
    const clipped = padLineToWidth(line, 10, BG);
    // 4 cells of indent + three 2-cell glyphs = 10; the fourth would straddle
    expect(lineText(clipped)).toBe("    一二三");
    expect(lineWidth(clipped)).toBe(10);
  });

  test("a wide glyph landing on the last odd cell is dropped, not split", () => {
    expect(lineWidth(padLineToWidth(tline([tspan("abc中")]), 5, BG))).toBe(5); // exactly full: no clip
    const clipped = padLineToWidth(tline([tspan("abc中")]), 4, BG);
    expect(lineText(clipped)).toBe("abc ");
    expect(lineWidth(clipped)).toBe(4); // filler restores the row to 4 cells
  });

  test("a surrogate pair is never cut in half", () => {
    const clipped = padLineToWidth(tline([tspan("😀😀", { fg: BG })]), 3, BG);
    expect(clipped.spans[0]!.text).toBe("😀");
    expect(Array.from(clipped.spans[0]!.text).length).toBe(1);
  });
});

describe("sanitize firewall (SPEC §22.5)", () => {
  test("whole ANSI sequences are stripped, CSI and OSC alike", () => {
    expect(sanitize("safe\x1b[31mred\x1b[0m")).toBe("safered");
    expect(sanitize("\x1b[2K")).toBe("");
    expect(sanitize("\x1b]8;;https://evil\x07link\x1b]8;;\x07")).toBe("link");
  });

  test("C0, DEL and C1 control characters are stripped", () => {
    expect(sanitize("a\x00b\x1fc\x7fd")).toBe("abcd");
    expect(sanitize("x\x80\x85\x9fy")).toBe("xy");
    expect(sanitize("plain text")).toBe("plain text");
  });

  test("padLineToWidth sanitizes before clipping and padding", () => {
    // A skill description smuggling a clear-line sequence and a NUL arrives
    // as plain text; the row still pads to the full width.
    const line = tline([tspan("ab\x1b[2Kcd\x00", { fg: BG })]);
    const padded = padLineToWidth(line, 10, BG);
    expect(lineText(padded)).toBe("abcd" + " ".repeat(6));
    expect(lineWidth(padded)).toBe(10);
  });

  test("a span emptied by the firewall drops out instead of padding wrong", () => {
    const line = tline([tspan("\x1b[31m", { fg: BG }), tspan("ok")]);
    const padded = padLineToWidth(line, 6, BG);
    expect(lineText(padded)).toBe("ok" + " ".repeat(4));
    expect(lineWidth(padded)).toBe(6);
  });
});
