// East Asian display width with an embedded codepoint interval table
// (SPEC §22.5): Wide/Fullwidth = 2 cells,
// Ambiguous = 1 (matching ratatui/unicode-width defaults), combining marks
// and control characters = 0 as a defense. The benchmark charset is pinned
// by wcwidth.test.ts: █ ░ · ¥ ● ↑ → measure 1 cell, 中 measures 2.
//
// Intervals derive from the Unicode EastAsianWidth data (W/F classes). The
// table is sorted and non-overlapping so membership is a binary search.

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b], // watch / hourglass
  [0x2329, 0x232a], // angle brackets
  [0x23e9, 0x23ec], // media control symbols
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, symbols
  [0x3041, 0x33ff], // Hiragana .. CJK compatibility
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe52], // CJK compatibility forms
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x16fe0, 0x16fe4],
  [0x17000, 0x187f7], // Tangut
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb], // Nushu
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320], // emoji: weather
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa74],
  [0x1fa78, 0x1fa7c],
  [0x1fa80, 0x1fa86],
  [0x1fa90, 0x1faac],
  [0x1fab0, 0x1faba],
  [0x1fabd, 0x1fabf],
  [0x1face, 0x1fadb],
  [0x1fae0, 0x1fae8],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd], // CJK Ext B and beyond
  [0x30000, 0x3fffd],
];

/** Zero-width: combining marks, variation selectors, joiners, and the
 *  invisible format controls — the union unicode-width treats as zero
 *  (sorted, non-overlapping; binary-searched). */
const ZERO_RANGES: [number, number][] = [
  [0x0300, 0x036f], // combining diacriticals
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x05c4, 0x05c5],
  [0x05c7, 0x05c7],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x1ab0, 0x1aff], // combining diacriticals extended
  [0x1dc0, 0x1dff], // combining diacriticals supplement
  [0x200b, 0x200f], // zero-width space/joiners
  [0x202a, 0x202e], // bidi embedding/override controls
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x20d0, 0x20ff], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xe0100, 0xe01ef], // variation selectors supplement
];

const inRanges = (ranges: [number, number][], cp: number): boolean => {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
};

/** Cell width of one codepoint. Control characters measure 0 defensively —
 *  sanitize() strips them before rendering anyway. */
export function charWidth(cp: number): number {
  if (cp === 0 || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(ZERO_RANGES, cp)) return 0;
  return inRanges(WIDE_RANGES, cp) ? 2 : 1;
}

/** Cell width of a string, iterating codepoints (not UTF-16 units). */
export function stringWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0)!);
  return width;
}

/** Clip to at most `width` cells. A wide character straddling the boundary is
 *  dropped whole — terminals must never receive half of a 2-cell glyph. */
export function clipToWidth(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}
