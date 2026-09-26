// Read-only skills list view — a pure port of rust/src/ui/skills_view.rs to
// the TuiLine model (SPEC 21.3): a "N skills" summary in the title, rows
// grouped by source, two display lines per skill, and a viewport that keeps
// the selected item's name AND description lines visible (REVIEW-RUST
// Minor 11). Selection moves over items only (group headers are skipped)
// exactly like app.rs::move_skills_sel.

import type { SkillInfo } from "../core/skills.ts";
import type { Palette } from "../core/theme.ts";
import { padLineToWidth, tline, tspan, type TuiLine } from "./line.ts";

export const SKILLS_FOOTER = "↑/↓ Scroll · r Rescan · Esc Back · q Quit";

const TITLE = "Kimi Skills";
/** Same chunk math as the settings view: rows 0..3, content from row 4. */
const HEADER_ROWS = 4;

export type SkillRow =
  | { kind: "group"; source: string }
  | { kind: "item"; name: string; description: string };

/** Flatten the sorted scan result into group headers + items (app.rs::set_skills). */
export function buildSkillRows(skills: SkillInfo[]): SkillRow[] {
  const rows: SkillRow[] = [];
  let lastSource: string | null = null;
  for (const s of skills) {
    if (lastSource !== s.source) {
      rows.push({ kind: "group", source: s.source });
      lastSource = s.source;
    }
    rows.push({ kind: "item", name: s.name, description: s.description });
  }
  return rows;
}

export function firstItemIndex(rows: SkillRow[]): number | null {
  const at = rows.findIndex((r) => r.kind === "item");
  return at < 0 ? null : at;
}

/** Move the highlight to the next/previous item, wrapping around; group
 *  headers are never selectable. */
export function moveSkillSel(rows: SkillRow[], sel: number, dir: number): number {
  if (rows.length === 0) return 0;
  const len = rows.length;
  let i = sel;
  for (let step = 0; step < len; step++) {
    i = (((i + dir) % len) + len) % len;
    if (rows[i]!.kind === "item") return i;
  }
  return sel;
}

/** Display lines + the line index each row starts on (the Rust `row_line`). */
export function skillsDisplayLines(rows: SkillRow[], sel: number, p: Palette): {
  lines: TuiLine[];
  rowLine: number[];
} {
  const lines: TuiLine[] = [];
  const rowLine: number[] = [];
  rows.forEach((row, idx) => {
    rowLine.push(lines.length);
    if (row.kind === "group") {
      if (idx > 0) lines.push(tline([]));
      lines.push(tline([tspan(row.source, { fg: p.accent, bold: true })]));
      return;
    }
    const selected = idx === sel;
    lines.push(
      tline([
        tspan(`  ${row.name}`, {
          fg: p.textPrimary,
          bold: true,
          ...(selected ? { bg: p.buttonHover } : {}),
        }),
      ]),
    );
    lines.push(
      tline([
        tspan(`    ${row.description}`, {
          fg: p.textSecondary,
          ...(selected ? { bg: p.buttonHover } : {}),
        }),
      ]),
    );
  });
  return { lines, rowLine };
}

/** Scroll offset keeping the selected item FULLY visible — its name line AND
 *  description line (each item renders as two lines, SPEC 21.3). A selection
 *  that already fits never scrolls; `maxScroll` pins the view to the last
 *  page; out-of-range selections and short lists clamp safely. Pure so the
 *  both-lines-visible invariant is unit-testable (REVIEW-RUST Minor 11: the
 *  old `selLine + 1` budget pinned the name row to the bottom edge and
 *  clipped the description line right below the fold). */
export function scrollFor(selLine: number, viewport: number, maxScroll: number): number {
  return Math.min(Math.max(0, selLine + 2 - viewport), maxScroll);
}

/** SPEC 21.3: the top line is the title + summary; the summary counts items,
 *  and reads "Scanning..." while a background rescan is in flight (SPEC 21.2). */
export function skillsHeaderRows(summary: string, p: Palette): TuiLine[] {
  return [
    tline([]),
    tline([
      tspan(`  ${TITLE}`, { fg: p.textPrimary, bold: true }),
      tspan(`   ${summary}`, { fg: p.textSecondary }),
    ]),
    tline([]),
    tline([]),
  ];
}

export function renderSkillsRows(input: {
  rows: SkillRow[];
  sel: number;
  loading: boolean;
  width: number;
  height: number;
  palette: Palette;
}): TuiLine[] {
  const { rows, sel, loading, width, height, palette: p } = input;
  const count = loading ? null : rows.filter((r) => r.kind === "item").length;
  const summary = count === null ? "Scanning..." : `${count} skills`;
  const { lines, rowLine } = skillsDisplayLines(rows, sel, p);

  // Keep the selected item's name AND description lines inside the viewport
  // (rust/src/ui/skills_view.rs::scroll_for, REVIEW-RUST Minor 11).
  const viewport = Math.max(0, height - HEADER_ROWS - 1);
  const selLine = rowLine[sel] ?? 0;
  const maxScroll = Math.max(0, lines.length - viewport);
  const scroll = scrollFor(selLine, viewport, maxScroll);
  const visible = viewport > 0 ? lines.slice(scroll, scroll + viewport) : [];

  return [...skillsHeaderRows(summary, p), ...visible].map((l) =>
    padLineToWidth(l, width, p.windowBg),
  );
}

export function skillsFooterLine(p: Palette, width: number): TuiLine {
  return padLineToWidth(tline([tspan(SKILLS_FOOTER, { fg: p.textSecondary })]), width, p.windowBg);
}
