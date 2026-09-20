// Pure line model shared by the views and the screen writer (SPEC 12). The
// views emit `TuiLine[]` here; screen.ts turns them into ANSI rows. Keeping
// this layer free of terminal imports is the seam that lets the views stay
// pure functions and testable without a TTY.
//
// Design constraints carried over from the render-layer design
// (SPEC §22.5):
//  - rows are immutable values; a repaint rebuilds them and the screen diffs.
//  - nothing else fills the screen background, so every line is padded to the
//    full width with a windowBg filler run (padLineToWidth).
//  - streaming layout only, hence lines never carry x/y coordinates.
//  - widths are measured in CELLS via the wcwidth table, so a view emitting
//    CJK (skills view) can never overrun a column budget or split a surrogate
//    pair into the terminal.

import { clipToWidth, stringWidth } from "./wcwidth.ts";

export interface TuiSpan {
  text: string;
  /** #RRGGBB from the palette (SPEC 11.1); omitted means renderer default */
  fg?: string;
  bg?: string;
  bold?: boolean;
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

/** Cell width of a span run, measured with the wcwidth table: wide CJK counts
 *  2 cells, combining marks 0, and the count never splits a surrogate pair. */
export function spanWidth(text: string): number {
  return stringWidth(text);
}

export function lineWidth(line: TuiLine): number {
  return line.spans.reduce((w, s) => w + spanWidth(s.text), 0);
}

/** Plain text of a line — the shape snapshot tests compare against. */
export function lineText(line: TuiLine): string {
  return line.spans.map((s) => s.text).join("");
}

/** Bring a line to exactly `width` cells: clip the overflow cell-wise (a wide
 *  char straddling the boundary is dropped whole) and append a windowBg
 *  filler run so the row paints edge to edge. */
export function padLineToWidth(line: TuiLine, width: number, windowBg: string): TuiLine {
  let spans = line.spans;
  let used = lineWidth(line);
  if (used > width) {
    spans = [];
    used = 0;
    for (const s of line.spans) {
      if (used >= width) break;
      const clipped = clipToWidth(s.text, width - used);
      spans.push(clipped === s.text ? s : { ...s, text: clipped });
      used += spanWidth(clipped);
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

/** Stable serialization used by the screen diff to skip unchanged rows. */
export function lineKey(line: TuiLine): string {
  return JSON.stringify(line.spans);
}
