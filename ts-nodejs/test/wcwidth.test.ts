// Width-table pins (SPEC §22.5): the
// benchmark charset comes from the S0 probe conclusions — if the table drifts,
// column alignment in every view drifts with it.

import { describe, expect, test } from "./bun-shim.ts";
import { charWidth, clipToWidth, stringWidth } from "../src/tui/wcwidth.ts";

const cw = (ch: string): number => charWidth(ch.codePointAt(0)!);

describe("wcwidth benchmark charset (plan §2.3)", () => {
  test("block/bar/punctuation symbols measure 1 cell", () => {
    for (const ch of ["█", "░", "·", "¥", "●", "↑", "→"]) expect(cw(ch)).toBe(1);
  });

  test("CJK ideographs measure 2 cells", () => {
    expect(cw("中")).toBe(2);
    expect(cw("あ")).toBe(2);
    expect(cw("한")).toBe(2);
  });

  test("fullwidth forms and emoji measure 2 cells", () => {
    expect(cw("！")).toBe(2); // U+FF01
    expect(cw("😀")).toBe(2); // U+1F600, outside the BMP
  });

  test("ambiguous-width characters measure 1 cell (ratatui/unicode-width default)", () => {
    expect(cw("─")).toBe(1); // U+2500 box drawing
    expect(cw("§")).toBe(1);
  });
});

describe("wcwidth zero-width defense", () => {
  test("combining marks, variation selectors and joiners are 0 cells", () => {
    expect(charWidth(0x0301)).toBe(0); // combining acute accent
    expect(charWidth(0x200d)).toBe(0); // ZWJ
    expect(charWidth(0xfe0f)).toBe(0); // VS16
    expect(charWidth(0x1ab0)).toBe(0); // combining diacriticals extended
    expect(charWidth(0x1dc0)).toBe(0); // combining diacriticals supplement
    expect(charWidth(0x20dd)).toBe(0); // combining enclosing circle
    expect(charWidth(0x202e)).toBe(0); // RTL override (bidi control)
    expect(charWidth(0xfeff)).toBe(0); // BOM / zero-width no-break space
  });

  test("control characters are 0 cells (sanitize strips them anyway)", () => {
    expect(charWidth(0x00)).toBe(0);
    expect(charWidth(0x1b)).toBe(0); // ESC
    expect(charWidth(0x7f)).toBe(0); // DEL
    expect(charWidth(0x85)).toBe(0); // C1 NEL
  });
});

describe("stringWidth / clipToWidth", () => {
  test("stringWidth sums codepoint cells, not UTF-16 units", () => {
    expect(stringWidth("abc")).toBe(3);
    expect(stringWidth("中文")).toBe(4);
    expect(stringWidth("a中b")).toBe(4);
    expect(stringWidth("😀")).toBe(2);
  });

  test("clipToWidth clips plain ASCII", () => {
    expect(clipToWidth("abcdef", 3)).toBe("abc");
    expect(clipToWidth("abc", 10)).toBe("abc");
  });

  test("a wide char straddling the boundary is dropped whole", () => {
    expect(clipToWidth("a中b", 3)).toBe("a中");
    expect(clipToWidth("a中b", 2)).toBe("a");
    expect(clipToWidth("中文", 1)).toBe("");
  });
});
