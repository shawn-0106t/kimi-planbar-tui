// Pure line model shared by the views and the renderers (SPEC 12). The views
// emit `TuiLine[]` here; the OpenTUI adapter in renderer.ts turns them into
// one Text handle per row. Keeping this layer free of @opentui imports is the
// seam that lets the render layer be swapped wholesale (TS-EDITION-PLAN §7).
//
// Design constraints carried over from the S0 probe (TS-EDITION-PLAN §2.6):
//  - trap 1: Text content is write-once per frame in practice, so a repaint
//    rebuilds row handles; rows are therefore modeled as immutable values.
//  - trap 3: nothing fills the screen background, so every line is padded to
//    the full width with a window_bg filler run (padLineToWidth).
//  - streaming layout only, hence lines never carry x/y coordinates.

export interface TuiSpan {
  text: string;
  /** #RRGGBB from the palette (SPEC 11.1); omitted means renderer default */
  fg?: string;
  bg?: string;
  bold?: boolean;
  /** ratatui's Modifier::UNDERLINED equivalent (SPEC 13.2 selected interval row) */
  underline?: boolean;
}

export interface TuiLine {
  spans: TuiSpan[];
}

export type SpanStyle = Pick<TuiSpan, "fg" | "bg" | "bold" | "underline">;

export function tspan(text: string, style: SpanStyle = {}): TuiSpan {
  return { text, ...style };
}

export function tline(spans: TuiSpan[]): TuiLine {
  return { spans };
}

/** East Asian Wide/Fullwidth blocks that actually appear in Kimi skill
 *  frontmatter (SPEC 21.3): CJK ideographs, kana, Hangul, fullwidth forms and
 *  emoji. Ambiguous-width glyphs (`█ ░ · ¥ ● →`) stay at 1 cell, which is what
 *  ratatui's default `unicode-width` does and the S0 probe measured (see
 *  TS-EDITION-PLAN §2.6) — hence no ambiguous ranges here. */
const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Combining marks, joiners and variation selectors occupy no cell. */
const ZERO_WIDTH_RANGES: readonly [number, number][] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
];

const inRanges = (cp: number, ranges: readonly [number, number][]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Cell width of one code point — the TS stand-in for `unicode-width`. */
export function charWidth(cp: number): number {
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  if (cp < 0x20 || cp === 0x7f) return 0; // C0 controls: never drawn by ratatui
  return 1;
}

/** Terminal cell width of a run; unlike `text.length` this is correct for the
 *  CJK names and descriptions the skills view renders. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0)!);
  return w;
}

/** Cell width of a span run. */
export function spanWidth(text: string): number {
  return displayWidth(text);
}


export function lineWidth(line: TuiLine): number {
  return line.spans.reduce((w, s) => w + spanWidth(s.text), 0);
}

/** Plain text of a line — the shape snapshot tests compare against. */
export function lineText(line: TuiLine): string {
  return line.spans.map((s) => s.text).join("");
}

/** Take the first `cells` cells of a run. Iterating code points (not UTF-16
 *  units) keeps a surrogate pair and a 2-cell glyph from being cut in half —
 *  a wide character that does not fit the last cell is dropped whole, which is
 *  what ratatui's buffer does when a symbol crosses the area edge. */
function truncateToCells(text: string, cells: number): string {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > cells) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Bring a line to exactly `width` cells: clip the overflow (ratatui clips
 *  each area at its right edge; a too-long line here would otherwise reach the
 *  renderer unbounded) and append a window_bg filler run so the row paints
 *  edge to edge (probe trap 3). */
export function padLineToWidth(line: TuiLine, width: number, windowBg: string): TuiLine {
  let spans = line.spans;
  let used = lineWidth(line);
  if (used > width) {
    spans = [];
    used = 0;
    for (const s of line.spans) {
      if (used >= width) break;
      const keep = truncateToCells(s.text, width - used);
      if (keep !== "") {
        spans.push(keep === s.text ? s : { ...s, text: keep });
        used += displayWidth(keep);
      }
    }
  }
  const filler = width - used;
  if (filler > 0) spans = [...spans, tspan(" ".repeat(filler), { bg: windowBg })];
  return { spans };
}

/** Fully-blank background row: fills the vertical gap under the content. */
export function blankLine(width: number, windowBg: string): TuiLine {
  return tline([tspan(" ".repeat(width), { bg: windowBg })]);
}

/** Stable serialization used by the adapter to skip unchanged rows. */
export function lineKey(line: TuiLine): string {
  return JSON.stringify(line.spans);
}
