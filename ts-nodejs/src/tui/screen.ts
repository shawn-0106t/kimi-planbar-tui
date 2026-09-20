// Frame model and the write path (SPEC §22.5).
// A frame is TuiLine[]; each row renders to one ANSI string — spans are
// sanitized (§2.2), SGR-wrapped, hard-clipped to the terminal width by cell
// width (no wrapping, SPEC 12.2), and padded on the right with a windowBg
// run so the background paints edge to edge. Writes are line-diffed: only
// changed rows emit a cursor-position + row payload. The first frame clears.
//
// §3 trap 1: filling the bottom-right cell scrolls the whole screen, so the
// last row of a frame renders one cell short (DECAWM is also disabled at
// terminal entry; this is the belt-and-suspenders half).

import { sanitize, sgrOpen, SGR_RESET } from "./ansi.ts";
import { clipToWidth, stringWidth } from "./wcwidth.ts";
import type { TuiLine } from "./line.ts";

/** DEC 2026 synchronized output: WT 1.22+ / xterm.js buffer the frame between
 *  these markers; terminals that do not know the mode ignore it silently. */
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

/** One row -> ANSI text of exactly `width` cells. Every span is sanitized and
 *  the row ends with an SGR reset so styles cannot bleed into later writes. */
export function renderRow(line: TuiLine, width: number, windowBg: string): string {
  let out = "";
  let used = 0;
  for (const span of line.spans) {
    if (used >= width) break;
    const text = clipToWidth(sanitize(span.text), width - used);
    if (text === "") continue;
    used += stringWidth(text);
    out += sgrOpen(span) + text;
  }
  if (used < width) out += sgrOpen({ bg: windowBg }) + " ".repeat(width - used);
  return out + SGR_RESET;
}

export class Screen {
  private prev: string[] = [];
  private first = true;
  private width: number;
  private height: number;
  private readonly write: (text: string) => void;

  constructor(width: number, height: number, write: (text: string) => void) {
    this.width = width;
    this.height = height;
    this.write = write;
  }

  /** A resize invalidates the whole grid — the next frame repaints fully. */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.first = true;
  }

  /** Diff `lines` against the previous frame and emit the minimal update. */
  writeFrame(lines: TuiLine[], windowBg: string): void {
    const rows = lines.slice(0, Math.max(0, this.height)).map((line, i) => {
      const isBottomRow = i === this.height - 1;
      const width = isBottomRow ? this.width - 1 : this.width;
      return renderRow(line, Math.max(0, width), windowBg);
    });

    let body = this.first ? "\x1b[2J\x1b[H" : "";
    for (let i = 0; i < rows.length; i++) {
      if (!this.first && rows[i] === this.prev[i]) continue;
      body += `\x1b[${i + 1};1H` + rows[i];
    }
    // A shrinking frame leaves stale rows behind; clear them explicitly.
    for (let i = rows.length; i < this.prev.length; i++) {
      body += `\x1b[${i + 1};1H\x1b[2K`;
    }

    this.prev = rows;
    this.first = false;
    if (body === "") return;
    this.write(SYNC_BEGIN + body + SYNC_END);
  }
}
