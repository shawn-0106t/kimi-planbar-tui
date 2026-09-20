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
}

export interface TuiLine {
  spans: TuiSpan[];
}

export type SpanStyle = Pick<TuiSpan, "fg" | "bg" | "bold">;

export function tspan(text: string, style: SpanStyle = {}): TuiSpan {
  return { text, ...style };
}

export function tline(spans: TuiSpan[]): TuiLine {
  return { spans };
}

/** Cell width of a span run. Everything the dashboard draws (ASCII, `█ ░ · ¥`)
 *  measures 1 cell in both ratatui and OpenTUI (probe §2.6), so char count is
 *  the honest width here; wide CJK only appears in M3 views. */
export function spanWidth(text: string): number {
  return text.length;
}

export function lineWidth(line: TuiLine): number {
  return line.spans.reduce((w, s) => w + spanWidth(s.text), 0);
}

/** Plain text of a line — the shape snapshot tests compare against. */
export function lineText(line: TuiLine): string {
  return line.spans.map((s) => s.text).join("");
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
      const keep = Math.min(s.text.length, width - used);
      if (keep < s.text.length) spans.push({ ...s, text: s.text.slice(0, keep) });
      else spans.push(s);
      used += keep;
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
