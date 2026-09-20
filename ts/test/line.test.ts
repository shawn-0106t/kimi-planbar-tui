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
